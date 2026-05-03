/**
 * backlog/nl-parser.ts — Natural-language ticket parser.
 *
 * Two execution modes:
 *
 * 1. **Templated (dev / no API key)** — fast, deterministic, runs entirely
 *    in-process. A small ordered set of regex rules classifies the prompt as
 *    bug | epic | story and extracts a title + description + 2-3 ACs from the
 *    detected action verbs. Designed to be predictable and offline-safe.
 *
 * 2. **Anthropic Haiku (when ANTHROPIC_API_KEY is set)** — sends the prompt
 *    plus a compact summary of the locked vision content to Haiku and parses
 *    the JSON response. Cost is ~$0.0001 per parse. Falls through to the
 *    templated parser on any error so the UI never blocks on network issues.
 *
 * Both modes return the same `Proposal` shape, so callers (the tRPC procedure
 * and the UI) are unaware which engine produced the result.
 *
 * The parser is **stateless and pure** — it does not read or write the DB,
 * does not emit events, and does not allocate UUIDs for the aggregate
 * (the caller's create path does that). A `defect_id` IS allocated up-front
 * for bug proposals because the UI needs to display it on the proposal card
 * before persistence; the same UUID is then handed to `createStory`.
 */

import Anthropic from '@anthropic-ai/sdk'
import { uuidv7 } from 'uuidv7'
import { logger } from '../logger.js'
import { env } from '../../../orchestrator/src/config/env.js'
import type { AnthropicDriver } from '../../../orchestrator/src/personas/anthropic-driver.js'
import {
  buildNLParserSystemPrompt,
  buildNLParserUserPrompt,
  NLParserResponseSchema,
  type NLParserContext,
} from '../../../orchestrator/src/personas/prompts/nl-parser.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type ProposalKind = 'story' | 'bug' | 'epic'

export interface VisionContextSummary {
  /** Vision title; empty string if unavailable. */
  title: string
  /** Top-line summary; truncated to 500 chars. */
  summary: string
  /** Top 5 goal texts (from goals array). */
  topGoals: string[]
  /** Existing epic titles (so the parser can suggest one). */
  existingEpicTitles: string[]
}

export interface BugDetail {
  defect_id: string
  severity: 'low' | 'medium' | 'high' | 'critical'
}

export interface Proposal {
  kind: ProposalKind
  title: string
  description: string
  ac_titles: string[]
  /**
   * Existing epic the parser thinks this story belongs to. NULL when:
   *   - kind === 'epic' (the proposal IS an epic)
   *   - there are no existing epics
   *   - no clear keyword match
   */
  suggested_epic_title: string | null
  /** Lower = higher priority. Defaults: 100 for stories, 0/10 for bugs. */
  priority: number
  /** Default story-points estimate when one can be inferred; null otherwise. */
  story_points: number | null
  /**
   * Persona-of-record hint (informational). 'qa' for bugs, 'pm' for epics,
   * undefined for stories.
   */
  persona_of_record?: string
  /** Bug-only: defect id pre-allocated so it can flow to createStory unchanged. */
  bug?: BugDetail
  /** Which engine produced the proposal. Useful for debugging + UI hints. */
  parser_engine: 'templated' | 'anthropic'
  /** Human-readable reasoning bullets — surfaces why the parser chose this kind. */
  rationale: string[]
}

export interface ParserOptions {
  /**
   * Force a kind. When provided, the parser's classifier is bypassed; only
   * extraction runs. Useful when the user explicitly clicks "+ Bug" or
   * "+ Epic" in the UI rather than relying on language detection.
   */
  forceKind?: ProposalKind
  /** Disable the Anthropic call even if a key is configured (testing). */
  forceTemplated?: boolean
}

export interface NLParser {
  parse(prompt: string, vision: VisionContextSummary, opts?: ParserOptions): Promise<Proposal>
}

// ---------------------------------------------------------------------------
// Templated rules (dev mode)
// ---------------------------------------------------------------------------

/**
 * Order matters. The first rule whose `match` regex hits the prompt wins.
 * Each rule produces a partial proposal which `extractCommonFields` enriches
 * with the title / description / ACs.
 */
interface TemplatedRule {
  kind: ProposalKind
  /** Regex tested against the lowercased prompt. */
  match: RegExp
  /** Human-readable reason why this rule fired. */
  reason: string
  /** Severity classifier (bug rules only). */
  severity?: (prompt: string) => BugDetail['severity']
}

const BUG_KEYWORDS = [
  /\b(bug|broken|broke|crash(es|ed|ing)?|fail(s|ed|ing)?)\b/,
  /\b(error|exception|stacktrace|stack trace)\b/,
  /\b(doesn'?t work|isn'?t working|won'?t work|not working|does nothing|did nothing)\b/,
  /\b(regression|defect|typo)\b/,
  /\b(blank|white) screen\b/,
  /\bnothing happens\b/,
  /\b(returns?|throws?|gets?|got|returning) (a |an )?(500|400|404|403|503|error)\b/,
  /\b(production|prod) (is )?down\b/,
  /\boutage\b/,
]

const EPIC_KEYWORDS = [
  /\bepic\b/,
  /\btheme\b/,
  /\binitiative\b/,
  /\bmilestone\b/,
  /\boverhaul\b/,
  /\boverarching\b/,
]

const STORY_KEYWORDS = [
  /^i (want|need|would like)/,
  /^as (an? )?(user|customer|admin|operator)/,
  /^add(ing)?\b/,
  /^build(ing)?\b/,
  /^implement(ing)?\b/,
  /^create\b/,
  /\bfeature\b/,
]

const TEMPLATED_RULES: TemplatedRule[] = [
  // Bug rules first — bug language is more specific than story language.
  ...BUG_KEYWORDS.map<TemplatedRule>((rx) => ({
    kind: 'bug',
    match: rx,
    reason: `bug-language detected (${rx.source})`,
    severity: classifySeverity,
  })),
  // Epic rules: an explicit epic / theme keyword OR a multi-feature description
  // (heuristic: more than one " and " connecting capabilities).
  ...EPIC_KEYWORDS.map<TemplatedRule>((rx) => ({
    kind: 'epic',
    match: rx,
    reason: `epic-language detected (${rx.source})`,
  })),
  // Story rules: action verbs and "I want / as a user".
  ...STORY_KEYWORDS.map<TemplatedRule>((rx) => ({
    kind: 'story',
    match: rx,
    reason: `story-language detected (${rx.source})`,
  })),
]

function classifySeverity(prompt: string): BugDetail['severity'] {
  const p = prompt.toLowerCase()
  if (
    /\b(crit(ical)?|sev0|sev 0|outage|data loss|security)\b/.test(p) ||
    /\bprod(uction)?\s+(is\s+)?down\b/.test(p) ||
    /\bevery\s+user\b/.test(p)
  )
    return 'critical'
  if (
    /\b(high|sev1|sev 1|major|severe|users? blocked)\b/.test(p) ||
    /\bcrashes?\s+(every|always)/.test(p)
  )
    return 'high'
  if (/\b(low|sev3|sev 3|minor|cosmetic|typo|wording)\b/.test(p)) return 'low'
  return 'medium'
}

/**
 * Extract a sensible title from the first 6-8 words of the prompt with simple
 * cleanup (strip trailing punctuation, normalise whitespace, drop leading
 * pronouns when they are filler).
 */
export function extractTitle(prompt: string, kind: ProposalKind): string {
  const original = prompt.replace(/\s+/g, ' ').trim()
  if (original.length === 0) return `New ${kind}`

  const cleaned = original
    .replace(/^i (want|need|would like)( to)?\b\s*/i, '')
    .replace(/^as (an? )?(user|customer|admin|operator)[,\s]+i?\s*(want|need)?\s*(to )?/i, '')
    .replace(/^please\s+/i, '')
    .replace(/^(could you |can you )/i, '')
    .trim()
  // If stripping the prefix consumed the entire prompt, fall back to a
  // generic title so the user still sees something sensible to edit.
  if (cleaned.length === 0) return `New ${kind}`

  const words = cleaned.split(/\s+/).filter((w) => w.length > 0)
  if (words.length === 0) return `New ${kind}`
  const limit = Math.min(words.length, 8)
  let title = words.slice(0, limit).join(' ')
  // Strip trailing punctuation
  title = title.replace(/[.!?,:;]+$/, '')
  // Capitalise first letter
  title = title.charAt(0).toUpperCase() + title.slice(1)
  return title
}

/**
 * Extract 2-3 acceptance criteria from action verbs in the prompt. Default
 * fallback: a generic "behaviour matches user intent" AC.
 */
export function extractAcceptanceCriteria(
  prompt: string,
  kind: ProposalKind,
  bug: BugDetail | undefined,
): string[] {
  if (kind === 'bug' && bug) {
    return [
      'The reported defect is reproducible from the user description',
      'A regression test covers the failing path',
      'The defect does not reproduce after the fix',
    ]
  }

  if (kind === 'epic') {
    return [
      'The epic encompasses 3-7 related stories with clear acceptance',
      'Stories under the epic share a single user-facing outcome',
    ]
  }

  // Story heuristics: detect simple action verbs and tailor ACs around them.
  // Order matters — more specific patterns must come first. "password reset"
  // beats the generic "email/notification" rule below.
  const lower = prompt.toLowerCase()
  const acs: string[] = []
  if (
    /\bpassword\s+reset\b/.test(lower) ||
    /\breset\s+password\b/.test(lower) ||
    /\bforgot(ten)?\s+password\b/.test(lower)
  ) {
    acs.push('User can request a password reset link with their email address')
    acs.push('Reset link is single-use and expires within 24 hours')
    acs.push('User can set a new password and is signed in afterwards')
  } else if (/\b(sign|log)\s+in\b|\blogin\b/.test(lower)) {
    acs.push('User can sign in with valid credentials')
    acs.push('Invalid credentials show a clear error and do not reveal which field was wrong')
  } else if (/\bsign\s*up\b|\bregister\b/.test(lower)) {
    acs.push('User can register with email and password')
    acs.push('Email is validated and duplicate registrations are rejected')
  } else if (/\bsearch\b|\bfilter\b/.test(lower)) {
    acs.push('Search/filter returns results matching the query')
    acs.push('Empty queries return all results without error')
  } else if (/\b(export|download)\b/.test(lower)) {
    acs.push('User can export data in the requested format')
    acs.push('Export contains the same rows visible to the user in the UI')
  } else if (/\bnotification|notify|email\b/.test(lower)) {
    acs.push('Notification is delivered to the intended recipient')
    acs.push('Notification can be muted or unsubscribed from')
  }
  if (acs.length === 0) {
    // Generic fallback ACs
    acs.push(`The behaviour described above is implemented end-to-end`)
    acs.push('The implementation has automated test coverage for the happy path')
  }
  return acs.slice(0, 3)
}

/**
 * Match a prompt against existing epic titles using a simple word-overlap
 * heuristic. Returns the best-matching title or null when no overlap.
 *
 * Prefix-aware: "auth" matches "authentication" and vice versa, so a user
 * typing a colloquial short form still hits the corresponding epic.
 */
export function suggestEpic(prompt: string, epics: string[]): string | null {
  if (epics.length === 0) return null
  const tokens = tokenize(prompt)
  if (tokens.size === 0) return null
  let bestScore = 0
  let bestTitle: string | null = null
  for (const title of epics) {
    const epicTokens = tokenize(title)
    let overlap = 0
    for (const t of epicTokens) {
      for (const promptTok of tokens) {
        if (
          t === promptTok ||
          (t.length >= 4 && promptTok.length >= 4 &&
            (t.startsWith(promptTok) || promptTok.startsWith(t)))
        ) {
          overlap += 1
          break
        }
      }
    }
    if (overlap > bestScore) {
      bestScore = overlap
      bestTitle = title
    }
  }
  // Require at least one meaningful overlap; otherwise no suggestion.
  return bestScore >= 1 ? bestTitle : null
}

const STOP_WORDS = new Set([
  'a', 'an', 'and', 'or', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'i', 'we', 'you', 'they', 'it', 'to', 'of', 'in', 'on', 'for', 'with', 'as', 'at',
  'by', 'from', 'this', 'that', 'these', 'those', 'so', 'do', 'does', 'did', 'have',
  'has', 'had', 'will', 'would', 'should', 'could', 'can', 'cannot', 'not', 'no', 'yes',
  'want', 'need', 'like', 'just', 'really', 'very', 'please',
])

function tokenize(s: string): Set<string> {
  const out = new Set<string>()
  for (const raw of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (raw.length < 3) continue
    if (STOP_WORDS.has(raw)) continue
    out.add(raw)
  }
  return out
}

/**
 * Run the templated parser. Pure function — no IO.
 */
export function parseTemplated(
  prompt: string,
  vision: VisionContextSummary,
  opts: ParserOptions = {},
): Proposal {
  const trimmed = prompt.trim()
  if (trimmed.length === 0) {
    throw new Error('Prompt is empty')
  }

  let kind: ProposalKind
  const reasons: string[] = []

  if (opts.forceKind) {
    kind = opts.forceKind
    reasons.push(`forceKind=${opts.forceKind} (UI override)`)
  } else {
    const lower = trimmed.toLowerCase()
    const matched = TEMPLATED_RULES.find((r) => r.match.test(lower))
    if (matched) {
      kind = matched.kind
      reasons.push(matched.reason)
    } else {
      kind = 'story'
      reasons.push('default kind=story (no rule matched)')
    }
  }

  // Bug detail is pre-allocated so the UI can render the defect_id on the
  // proposal card and the same id flows to createStory unchanged.
  let bug: BugDetail | undefined
  if (kind === 'bug') {
    bug = {
      defect_id: uuidv7(),
      severity: classifySeverity(trimmed),
    }
    reasons.push(`severity=${bug.severity}`)
  }

  const title = extractTitle(trimmed, kind)
  const ac_titles = extractAcceptanceCriteria(trimmed, kind, bug)

  // Description = the user's prompt verbatim (preserved as the canonical
  // record), plus a one-line generated clarification when the kind isn't
  // already evident in the language.
  const clarification =
    kind === 'bug'
      ? `Reported as a bug; severity ${bug?.severity ?? 'medium'}.`
      : kind === 'epic'
        ? 'Captured as an epic; decompose into stories during refinement.'
        : 'Captured as a user story.'
  const description = `${trimmed}\n\n${clarification}`

  const suggested_epic_title =
    kind === 'epic' ? null : suggestEpic(trimmed, vision.existingEpicTitles)
  if (suggested_epic_title) {
    reasons.push(`suggested epic="${suggested_epic_title}" (token-overlap)`)
  }

  // Heuristic estimate: 1 for trivial bug, 3 for typical story, null for epic.
  let story_points: number | null = null
  if (kind === 'bug' && bug?.severity === 'low') story_points = 1
  else if (kind === 'bug') story_points = 2
  else if (kind === 'story') story_points = 3

  // Bug priority shifts based on severity: critical=0, high=10, medium=100, low=200.
  let priority = 100
  if (kind === 'bug' && bug) {
    if (bug.severity === 'critical') priority = 0
    else if (bug.severity === 'high') priority = 10
    else if (bug.severity === 'low') priority = 200
  }

  const persona_of_record =
    kind === 'bug' ? 'qa' : kind === 'epic' ? 'pm' : undefined

  const proposal: Proposal = {
    kind,
    title,
    description,
    ac_titles,
    suggested_epic_title,
    priority,
    story_points,
    parser_engine: 'templated',
    rationale: reasons,
  }
  if (persona_of_record !== undefined) proposal.persona_of_record = persona_of_record
  if (bug !== undefined) proposal.bug = bug
  return proposal
}

// ---------------------------------------------------------------------------
// Anthropic-backed parser (production mode)
// ---------------------------------------------------------------------------

const HAIKU_MODEL = 'claude-haiku-4-5'

/**
 * Internal: call Haiku to classify and structure the prompt. Returns the same
 * Proposal shape as the templated parser. On any failure (network, schema,
 * timeout) the caller is expected to fall through to `parseTemplated`.
 */
async function parseWithAnthropic(
  prompt: string,
  vision: VisionContextSummary,
  apiKey: string,
  opts: ParserOptions,
): Promise<Proposal> {
  const client = new Anthropic({ apiKey, timeout: 5_000, maxRetries: 0 })
  const visionBlurb = renderVisionContext(vision)
  const epicList =
    vision.existingEpicTitles.length === 0
      ? 'None.'
      : vision.existingEpicTitles.map((t) => `- ${t}`).join('\n')

  const forced = opts.forceKind ? `\nThe user has indicated this is a "${opts.forceKind}" — respect that classification.` : ''

  const userMsg = `You are classifying a single user request into a backlog ticket for an
agile product team. Return STRICT JSON with no prose.

Vision context:
${visionBlurb}

Existing epics:
${epicList}

User prompt:
"""
${prompt.slice(0, 4000)}
"""${forced}

Respond with JSON exactly matching this shape:
{
  "kind": "story" | "bug" | "epic",
  "title": string (max 80 chars),
  "description": string (1-3 sentences),
  "ac_titles": string[] (2-3 items),
  "suggested_epic_title": string | null (must match an existing epic from the list above, or null),
  "priority": number (0=critical, 100=normal, 200=low),
  "story_points": number | null (Fibonacci: 1, 2, 3, 5, 8, 13),
  "severity": "low" | "medium" | "high" | "critical" (only when kind==="bug"),
  "rationale": string[] (1-2 short bullets explaining the classification)
}`

  const response = await client.messages.create({
    model: HAIKU_MODEL,
    max_tokens: 800,
    messages: [{ role: 'user', content: userMsg }],
  })

  const block = response.content.find((b) => b.type === 'text')
  if (!block || block.type !== 'text') {
    throw new Error('Anthropic returned no text content')
  }
  const json = extractJson(block.text)
  const parsed = JSON.parse(json) as Record<string, unknown>

  const kind = parsed['kind']
  if (kind !== 'story' && kind !== 'bug' && kind !== 'epic') {
    throw new Error(`Anthropic returned invalid kind: ${String(kind)}`)
  }

  const title = String(parsed['title'] ?? '').slice(0, 200) || extractTitle(prompt, kind)
  const description = String(parsed['description'] ?? '') || prompt
  const acs = Array.isArray(parsed['ac_titles']) ? parsed['ac_titles'] : []
  const ac_titles = acs
    .map((a) => String(a ?? ''))
    .filter((s) => s.trim().length > 0)
    .slice(0, 3)
  if (ac_titles.length === 0) ac_titles.push('Behaviour matches the user description')

  const suggestedRaw = parsed['suggested_epic_title']
  const suggested_epic_title =
    typeof suggestedRaw === 'string' && vision.existingEpicTitles.includes(suggestedRaw)
      ? suggestedRaw
      : null

  const priority = numberOr(parsed['priority'], kind === 'bug' ? 10 : 100)
  const points = numberOrNull(parsed['story_points'])

  const rationaleRaw = Array.isArray(parsed['rationale']) ? parsed['rationale'] : []
  const rationale = rationaleRaw.map((r) => String(r ?? '')).filter((s) => s.length > 0)
  rationale.unshift(`engine=anthropic/${HAIKU_MODEL}`)

  let bug: BugDetail | undefined
  if (kind === 'bug') {
    const sev = parsed['severity']
    const severity: BugDetail['severity'] =
      sev === 'low' || sev === 'high' || sev === 'critical' || sev === 'medium'
        ? sev
        : classifySeverity(prompt)
    bug = { defect_id: uuidv7(), severity }
  }

  const persona_of_record =
    kind === 'bug' ? 'qa' : kind === 'epic' ? 'pm' : undefined

  const proposal: Proposal = {
    kind,
    title,
    description,
    ac_titles,
    suggested_epic_title,
    priority,
    story_points: points,
    parser_engine: 'anthropic',
    rationale,
  }
  if (persona_of_record !== undefined) proposal.persona_of_record = persona_of_record
  if (bug !== undefined) proposal.bug = bug
  return proposal
}

function numberOr(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const parsed = Number(v)
    if (Number.isFinite(parsed)) return parsed
  }
  return fallback
}

function numberOrNull(v: unknown): number | null {
  if (v === null || v === undefined) return null
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string') {
    const parsed = Number(v)
    if (Number.isFinite(parsed)) return parsed
  }
  return null
}

function extractJson(text: string): string {
  // Haiku occasionally wraps JSON in ```json ... ``` fences. Strip them.
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)
  if (fenceMatch && fenceMatch[1]) return fenceMatch[1].trim()
  return text.trim()
}

function renderVisionContext(v: VisionContextSummary): string {
  if (!v.title && !v.summary && v.topGoals.length === 0) {
    return '(no locked vision available)'
  }
  const parts: string[] = []
  if (v.title) parts.push(`Title: ${v.title}`)
  if (v.summary) parts.push(`Summary: ${v.summary}`)
  if (v.topGoals.length > 0) {
    parts.push(`Goals:\n${v.topGoals.map((g) => `- ${g}`).join('\n')}`)
  }
  return parts.join('\n')
}

// ---------------------------------------------------------------------------
// Public default parser (chooses engine)
// ---------------------------------------------------------------------------

class DefaultNLParser implements NLParser {
  constructor(private readonly driver: AnthropicDriver | null = null) {}

  async parse(
    prompt: string,
    vision: VisionContextSummary,
    opts: ParserOptions = {},
  ): Promise<Proposal> {
    const trimmed = prompt.trim()
    if (trimmed.length === 0) {
      throw new Error('Prompt is empty')
    }

    // Preferred path: AnthropicDriver (forces tool-use JSON; reports cost).
    if (!opts.forceTemplated && this.driver) {
      try {
        return await parseWithDriver(trimmed, vision, this.driver, opts)
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'NL parser: AnthropicDriver call failed, falling back to legacy Anthropic SDK path',
        )
      }
    }

    // Legacy path: direct Anthropic SDK call (no cost reporting). Kept for
    // back-compat on the install where the driver hasn't been wired yet.
    const apiKey = env.ANTHROPIC_API_KEY
    if (!opts.forceTemplated && apiKey && apiKey.trim().length > 0) {
      try {
        return await parseWithAnthropic(trimmed, vision, apiKey, opts)
      } catch (err) {
        logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'NL parser: Anthropic call failed, falling back to templated rules',
        )
      }
    }

    return parseTemplated(trimmed, vision, opts)
  }
}

// ---------------------------------------------------------------------------
// AnthropicDriver path
// ---------------------------------------------------------------------------

async function parseWithDriver(
  prompt: string,
  vision: VisionContextSummary,
  driver: AnthropicDriver,
  opts: ParserOptions,
): Promise<Proposal> {
  const ctx: NLParserContext = {
    visionTitle: vision.title,
    visionSummary: vision.summary,
    topGoals: vision.topGoals,
    existingEpicTitles: vision.existingEpicTitles,
  }
  if (opts.forceKind) ctx.forceKind = opts.forceKind

  const systemPrompt = buildNLParserSystemPrompt()
  const userPrompt = buildNLParserUserPrompt(prompt, ctx)

  const result = await driver.invoke({
    persona: 'nl-parser',
    riskClass: 'low',
    sessionId: `nl-parse-${uuidv7()}`,
    systemPrompt,
    userPrompt,
    responseSchema: NLParserResponseSchema,
    maxTokens: 1024,
  })

  const r = result.result
  const ac_titles = r.ac_titles.slice(0, 3)
  if (ac_titles.length === 0) ac_titles.push('Behaviour matches the user description')

  // Validate suggested epic against existing list — model may hallucinate.
  const suggested_epic_title =
    typeof r.suggested_epic_title === 'string' && vision.existingEpicTitles.includes(r.suggested_epic_title)
      ? r.suggested_epic_title
      : null

  let bug: BugDetail | undefined
  if (r.kind === 'bug') {
    const severity: BugDetail['severity'] = r.severity ?? classifySeverity(prompt)
    bug = { defect_id: uuidv7(), severity }
  }

  const persona_of_record =
    r.kind === 'bug' ? 'qa' : r.kind === 'epic' ? 'pm' : undefined

  const rationale = [...r.rationale]
  rationale.unshift(`engine=anthropic-driver/${result.model}`)

  const proposal: Proposal = {
    kind: r.kind,
    title: r.title,
    description: r.description || prompt,
    ac_titles,
    suggested_epic_title,
    priority: r.priority,
    story_points: r.story_points,
    parser_engine: 'anthropic',
    rationale,
  }
  if (persona_of_record !== undefined) proposal.persona_of_record = persona_of_record
  if (bug !== undefined) proposal.bug = bug
  return proposal
}

let _instance: NLParser | null = null
let _driver: AnthropicDriver | null = null

/** Boot wires the driver here so the singleton picks it up on first construction. */
export function configureNLParserDriver(driver: AnthropicDriver | null): void {
  _driver = driver
  // Reset the singleton so the next getNLParser() picks up the new driver.
  _instance = null
}

/** Lazy singleton — same instance is reused across requests. */
export function getNLParser(): NLParser {
  if (_instance === null) _instance = new DefaultNLParser(_driver)
  return _instance
}

/** Test-only override. */
export function setNLParser(p: NLParser | null): void {
  _instance = p
}
