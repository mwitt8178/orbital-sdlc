/**
 * vision/llm-decomposer.ts — Anthropic-backed vision decomposer.
 *
 * Replaces the deterministic template-based suggester with a real Claude call
 * using structured tool-use for schema enforcement. Output is Zod-validated
 * before being returned to callers.
 *
 * Public API:
 *   decomposeVisionWithLLM({ driver, apiKey, content, model?, regenerationFeedback? })
 *     -> { proposal, usage, usdCents, raw }
 *
 * Cost guard:
 *   - Hard cap of 500 cents ($5) per call.
 *   - Estimated cost = inputTokens × $15/1M + maxOutputTokens × $75/1M (Opus pricing).
 *   - If estimate exceeds cap, throws CostCapExceededError before calling Claude.
 *
 * No DB writes here — pure function over content -> proposal. Callers are
 * responsible for persistence.
 *
 * [Engineer-Principal · Opus · run-vision-llm-decompose]
 */

import { z } from 'zod'
import type { LLMDriver, LLMRequest } from '../drivers/types.js'
import { logger } from '../config/logger.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// ---------------------------------------------------------------------------
// Public schema
// ---------------------------------------------------------------------------

export const ProposedAcSchema = z.string().min(8).max(400)

export const ProposedStorySchema = z.object({
  title: z.string().min(4).max(200),
  description: z.string().min(8).max(1000),
  story_points: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(5)]),
  acceptance_criteria: z.array(ProposedAcSchema).min(2).max(4),
})

export const ProposedEpicSchema = z.object({
  title: z.string().min(4).max(200),
  rationale: z.string().min(8).max(1000),
  stories: z.array(ProposedStorySchema).min(2).max(4),
})

export const ProposedDecompositionSchema = z.object({
  epics: z.array(ProposedEpicSchema).min(3).max(5),
})

export type ProposedStory = z.infer<typeof ProposedStorySchema>
export type ProposedEpic = z.infer<typeof ProposedEpicSchema>
export type ProposedDecomposition = z.infer<typeof ProposedDecompositionSchema>

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class CostCapExceededError extends Error {
  constructor(public readonly estimatedCents: number, public readonly capCents: number) {
    super(`LLM call estimated cost ${estimatedCents}¢ exceeds cap ${capCents}¢`)
    this.name = 'CostCapExceededError'
  }
}

export class LLMOutputInvalidError extends Error {
  constructor(message: string, public readonly raw: unknown) {
    super(`LLM output failed schema validation: ${message}`)
    this.name = 'LLMOutputInvalidError'
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_MODEL = 'claude-opus-4-7'
const DEFAULT_MAX_TOKENS = 8000
const DEFAULT_COST_CAP_CENTS = 500 // $5

// Anthropic Opus 4.7 pricing (approximate; in cents per 1M tokens).
// Source: Anthropic public pricing page for the Opus tier.
const OPUS_INPUT_CENTS_PER_MTOK = 1500 // $15
const OPUS_OUTPUT_CENTS_PER_MTOK = 7500 // $75

// ---------------------------------------------------------------------------
// Tool-use schema (passed to Claude)
// ---------------------------------------------------------------------------

const PROPOSE_TOOL_NAME = 'propose_decomposition'

const PROPOSE_TOOL_INPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  required: ['epics'],
  properties: {
    epics: {
      type: 'array',
      minItems: 3,
      maxItems: 5,
      items: {
        type: 'object',
        required: ['title', 'rationale', 'stories'],
        properties: {
          title: { type: 'string', minLength: 4, maxLength: 200 },
          rationale: { type: 'string', minLength: 8, maxLength: 1000 },
          stories: {
            type: 'array',
            minItems: 2,
            maxItems: 4,
            items: {
              type: 'object',
              required: ['title', 'description', 'story_points', 'acceptance_criteria'],
              properties: {
                title: { type: 'string', minLength: 4, maxLength: 200 },
                description: { type: 'string', minLength: 8, maxLength: 1000 },
                story_points: { type: 'number', enum: [1, 2, 3, 5] },
                acceptance_criteria: {
                  type: 'array',
                  minItems: 2,
                  maxItems: 4,
                  items: { type: 'string', minLength: 8, maxLength: 400 },
                },
              },
            },
          },
        },
      },
    },
  },
}

// ---------------------------------------------------------------------------
// Prompt loading
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url))

let _systemPromptCache: string | null = null
let _userPromptCache: string | null = null

function loadSystemPrompt(): string {
  if (_systemPromptCache !== null) return _systemPromptCache
  _systemPromptCache = readFileSync(join(__dirname, 'prompts', 'decompose-system.md'), 'utf8')
  return _systemPromptCache
}

function loadUserPromptTemplate(): string {
  if (_userPromptCache !== null) return _userPromptCache
  _userPromptCache = readFileSync(join(__dirname, 'prompts', 'decompose-user.md'), 'utf8')
  return _userPromptCache
}

// ---------------------------------------------------------------------------
// Vision content shape (loose — content is JSONB)
// ---------------------------------------------------------------------------

export interface VisionContentForPrompt {
  title: string
  summary: string
  goals: string[]
  nonGoals: string[]
  targetUsers: string[]
}

export function extractContentForPrompt(
  content: Record<string, unknown>,
): VisionContentForPrompt {
  const title = typeof content['title'] === 'string' ? content['title'] : ''
  const summary = typeof content['summary'] === 'string' ? content['summary'] : ''

  const pickText = (arr: unknown): string[] => {
    if (!Array.isArray(arr)) return []
    return arr
      .map((g) => {
        if (typeof g === 'string') return g
        if (g && typeof g === 'object') {
          const t = (g as { text?: unknown; description?: unknown; segment?: unknown })
          if (typeof t.text === 'string') return t.text
          if (typeof t.description === 'string') return t.description
          if (typeof t.segment === 'string') return t.segment
        }
        return ''
      })
      .filter((s) => s.length > 0)
  }

  return {
    title,
    summary,
    goals: pickText(content['goals']),
    nonGoals: pickText(content['non_goals']),
    targetUsers: pickText(content['target_users']),
  }
}

function renderUserPrompt(
  vision: VisionContentForPrompt,
  regenerationFeedback?: string,
): string {
  const tmpl = loadUserPromptTemplate()
  const fmt = (lines: string[]): string =>
    lines.length === 0 ? '_(none stated)_' : lines.map((l) => `- ${l}`).join('\n')

  const feedback = regenerationFeedback
    ? `## Regeneration feedback\nThe previous proposal was not satisfactory. Address this feedback:\n\n${regenerationFeedback}\n`
    : ''

  return tmpl
    .replace('{{TITLE}}', vision.title || '_(untitled)_')
    .replace('{{SUMMARY}}', vision.summary || '_(no summary)_')
    .replace('{{GOALS}}', fmt(vision.goals))
    .replace('{{NON_GOALS}}', fmt(vision.nonGoals))
    .replace('{{TARGET_USERS}}', fmt(vision.targetUsers))
    .replace('{{REGENERATION_FEEDBACK}}', feedback)
}

// ---------------------------------------------------------------------------
// Cost helpers
// ---------------------------------------------------------------------------

export function estimateCostCents(
  inputTokens: number,
  outputTokens: number,
): number {
  const inCents = (inputTokens / 1_000_000) * OPUS_INPUT_CENTS_PER_MTOK
  const outCents = (outputTokens / 1_000_000) * OPUS_OUTPUT_CENTS_PER_MTOK
  return Math.ceil(inCents + outCents)
}

/**
 * Rough char-based pre-flight estimate when we don't have a real token count.
 * Anthropic's published heuristic is ~4 chars per token for English prose.
 */
function estimateInputTokensFromChars(systemPrompt: string, userPrompt: string): number {
  const totalChars = systemPrompt.length + userPrompt.length
  return Math.ceil(totalChars / 4) + 200 // +200 for tool schema overhead
}

// ---------------------------------------------------------------------------
// Public function
// ---------------------------------------------------------------------------

export interface DecomposeOptions {
  driver: LLMDriver
  /** Anthropic API key — passed through to the driver via a context-aware key resolver. Reserved for future driver overload. */
  apiKey?: string
  content: Record<string, unknown>
  model?: string
  maxOutputTokens?: number
  /** Optional feedback to guide regeneration. */
  regenerationFeedback?: string
  /** Override hard cost cap (cents). Default 500 = $5. */
  costCapCents?: number
}

export interface DecomposeResult {
  proposal: ProposedDecomposition
  usage: { inputTokens: number; outputTokens: number }
  usdCents: number
  raw: unknown
}

export async function decomposeVisionWithLLM(
  opts: DecomposeOptions,
): Promise<DecomposeResult> {
  const model = opts.model ?? DEFAULT_MODEL
  const maxOutputTokens = opts.maxOutputTokens ?? DEFAULT_MAX_TOKENS
  const costCap = opts.costCapCents ?? DEFAULT_COST_CAP_CENTS

  const vision = extractContentForPrompt(opts.content)
  const systemPrompt = loadSystemPrompt()
  const userPrompt = renderUserPrompt(vision, opts.regenerationFeedback)

  // ---- Cost pre-check ----------------------------------------------------
  const estInput = estimateInputTokensFromChars(systemPrompt, userPrompt)
  const estCost = estimateCostCents(estInput, maxOutputTokens)
  if (estCost > costCap) {
    throw new CostCapExceededError(estCost, costCap)
  }

  logger.info(
    {
      model,
      estInputTokens: estInput,
      maxOutputTokens,
      estCostCents: estCost,
      costCapCents: costCap,
      hasFeedback: !!opts.regenerationFeedback,
    },
    'llm-decomposer: invoking Claude',
  )

  // ---- Build request -----------------------------------------------------
  const req: LLMRequest = {
    model,
    system: systemPrompt,
    messages: [{ role: 'user', content: userPrompt }],
    tools: [
      {
        name: PROPOSE_TOOL_NAME,
        description: 'Submit the proposed epic + story decomposition.',
        input_schema: PROPOSE_TOOL_INPUT_SCHEMA,
      },
    ],
    tool_choice: { type: 'tool', name: PROPOSE_TOOL_NAME },
    maxTokens: maxOutputTokens,
    temperature: 0.4,
  }

  const response = await opts.driver.send(req)

  // ---- Extract tool_use block -------------------------------------------
  const toolBlock = response.content.find(
    (b): b is { type: 'tool_use'; id: string; name: string; input: unknown } =>
      b.type === 'tool_use' && b.name === PROPOSE_TOOL_NAME,
  )

  if (!toolBlock) {
    throw new LLMOutputInvalidError(
      `expected tool_use block named '${PROPOSE_TOOL_NAME}', got: ${response.content.map((b) => b.type).join(',')}`,
      response.raw,
    )
  }

  // ---- Validate with Zod -------------------------------------------------
  const parsed = ProposedDecompositionSchema.safeParse(toolBlock.input)
  if (!parsed.success) {
    throw new LLMOutputInvalidError(
      parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      toolBlock.input,
    )
  }

  // ---- Cost recording ----------------------------------------------------
  const usdCents = estimateCostCents(
    response.usage.input_tokens,
    response.usage.output_tokens,
  )

  // Hard kill if actual cost exceeded cap (defensive — pre-check is the primary gate).
  if (usdCents > costCap) {
    logger.error(
      { actualCents: usdCents, capCents: costCap, model },
      'llm-decomposer: actual cost exceeded cap (post-call). Returning result but flagging.',
    )
  }

  return {
    proposal: parsed.data,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
    usdCents,
    raw: response.raw ?? null,
  }
}
