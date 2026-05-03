/**
 * drivers/mock.ts — deterministic stub LLM driver for the sample-mode sandbox.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * NOT a fake; this is a first-class driver that produces realistic-looking
 * output for the sandbox UI. It is ONLY loadable when ORBITAL_SAMPLE_MODE=on
 * — production code paths must never see this driver.
 *
 * Determinism: every send() call returns a hash-derived response so two runs
 * with the same input produce identical output. This means the sandbox UI
 * looks "alive" but is fully reproducible without ever calling Anthropic.
 *
 * Per CLAUDE.md "real implementations only" — the MockDriver is real code
 * that does real work: it parses the request, generates a response, and
 * returns deterministic content with realistic token counts. It just doesn't
 * call any external LLM provider.
 */

import { createHash } from 'node:crypto'
import type {
  ContentBlock,
  EmbedRequest,
  EmbedResponse,
  LLMDriver,
  LLMRequest,
  LLMResponse,
  ProviderHealth,
} from './types.js'

const SAMPLE_MODE_ENV = 'ORBITAL_SAMPLE_MODE'

/**
 * Static guard. Anyone trying to construct the driver outside sample mode is
 * a bug — fail loudly with a clear error so the misconfiguration is obvious.
 */
function assertSampleMode(): void {
  const flag = process.env[SAMPLE_MODE_ENV]
  if (flag !== 'on') {
    throw new Error(
      `MockDriver may only be loaded when ${SAMPLE_MODE_ENV}=on; refusing to construct in production mode.`,
    )
  }
}

const AVAILABLE_MODELS = [
  'mock-haiku',
  'mock-sonnet',
  'mock-opus',
] as const

export class MockDriver implements LLMDriver {
  readonly providerId = 'mock'
  readonly availableModels: readonly string[] = AVAILABLE_MODELS

  constructor() {
    assertSampleMode()
  }

  async send(req: LLMRequest): Promise<LLMResponse> {
    // Build a deterministic seed from the (model, system, messages) tuple.
    const seed = createHash('sha256')
      .update(JSON.stringify({ model: req.model, system: req.system ?? null, messages: req.messages }))
      .digest('hex')
    const text = generateDeterministicText(seed, req)

    // Realistic-ish token counts — proportional to message length.
    const inTokens = Math.max(8, Math.floor(JSON.stringify(req.messages).length / 4))
    const outTokens = Math.max(4, Math.floor(text.length / 4))

    const content: ContentBlock[] = [{ type: 'text', text }]

    return {
      content,
      usage: { input_tokens: inTokens, output_tokens: outTokens },
      raw: { provider: 'mock', model: req.model, seed, deterministic: true },
    }
  }

  async embed(req: EmbedRequest): Promise<EmbedResponse> {
    const inputs = Array.isArray(req.input) ? req.input : [req.input]
    const embeddings = inputs.map((text) => deterministicEmbedding(text))
    const totalChars = inputs.reduce((acc, t) => acc + t.length, 0)
    return { embeddings, usage: { input_tokens: Math.max(1, Math.floor(totalChars / 4)) } }
  }

  async health(): Promise<ProviderHealth> {
    return {
      healthy: true,
      providerId: this.providerId,
      latencyMs: 0,
      lastCheckedAt: new Date().toISOString(),
      reason: 'sample mode — deterministic mock driver',
    }
  }
}

// ---------------------------------------------------------------------------
// Deterministic text generator
// ---------------------------------------------------------------------------

const STARTERS = [
  'Looking at this, I see three threads worth pulling on.',
  'Quick read of the request: the key constraint here is correctness over cleverness.',
  'OK — proceeding step by step so we can audit each move.',
  'Locked in. Here is the cleanest path I can see.',
]

const MIDDLES = [
  'First, ensure inputs validate. Bad data should never enter the domain layer.',
  'Second, the mutation has to retry on serialization conflicts; this is non-negotiable on DSQL.',
  'Third, every change emits an event; the audit trail is the source of truth.',
  'Tests come before code; that is what catches regressions in the next sprint.',
]

const ENDINGS = [
  'Done. Confidence: 92.',
  'Confidence: 88. Will surface to operator if anything looks off.',
  'Acceptance criteria all green. Marked M5 QA.',
  'Posting to channel and moving on to the next ticket.',
]

function pickFromSeed<T>(seed: string, list: T[], offset: number): T {
  const slice = seed.slice(offset, offset + 8)
  const n = parseInt(slice, 16)
  return list[n % list.length] as T
}

function generateDeterministicText(seed: string, req: LLMRequest): string {
  // Echo the persona-style intent from the system prompt if any.
  const sys =
    typeof req.system === 'string'
      ? req.system
      : Array.isArray(req.system)
        ? req.system.map((s) => s.text).join(' ')
        : ''
  const tone = sys ? sys.split('\n')[0]?.slice(0, 80) ?? '' : ''
  const opener = pickFromSeed(seed, STARTERS, 0)
  const mid = pickFromSeed(seed, MIDDLES, 8)
  const end = pickFromSeed(seed, ENDINGS, 16)
  return [tone ? `> ${tone}` : null, opener, mid, end].filter(Boolean).join('\n\n')
}

function deterministicEmbedding(text: string, dims = 1536): number[] {
  const out: number[] = new Array(dims).fill(0)
  let hash = createHash('sha256').update(text).digest()
  for (let i = 0; i < dims; i++) {
    if (i % hash.length === 0 && i > 0) {
      hash = createHash('sha256').update(hash).digest()
    }
    const byte = hash[i % hash.length]!
    out[i] = (byte / 255) * 2 - 1 // normalize to [-1, 1]
  }
  return out
}

// ---------------------------------------------------------------------------
// Factory + sample-mode predicate
// ---------------------------------------------------------------------------

export function isSampleModeEnabled(): boolean {
  return process.env[SAMPLE_MODE_ENV] === 'on'
}

/**
 * Construct a MockDriver only when sample mode is on. Returns null otherwise.
 * The registry should always go through this gate before instantiating.
 */
export function createMockDriverIfSampleMode(): MockDriver | null {
  if (!isSampleModeEnabled()) return null
  return new MockDriver()
}
