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
import type { AnthropicDriver } from '../../../orchestrator/src/personas/anthropic-driver.js';
export type ProposalKind = 'story' | 'bug' | 'epic';
export interface VisionContextSummary {
    /** Vision title; empty string if unavailable. */
    title: string;
    /** Top-line summary; truncated to 500 chars. */
    summary: string;
    /** Top 5 goal texts (from goals array). */
    topGoals: string[];
    /** Existing epic titles (so the parser can suggest one). */
    existingEpicTitles: string[];
}
export interface BugDetail {
    defect_id: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
}
export interface Proposal {
    kind: ProposalKind;
    title: string;
    description: string;
    ac_titles: string[];
    /**
     * Existing epic the parser thinks this story belongs to. NULL when:
     *   - kind === 'epic' (the proposal IS an epic)
     *   - there are no existing epics
     *   - no clear keyword match
     */
    suggested_epic_title: string | null;
    /** Lower = higher priority. Defaults: 100 for stories, 0/10 for bugs. */
    priority: number;
    /** Default story-points estimate when one can be inferred; null otherwise. */
    story_points: number | null;
    /**
     * Persona-of-record hint (informational). 'qa' for bugs, 'pm' for epics,
     * undefined for stories.
     */
    persona_of_record?: string;
    /** Bug-only: defect id pre-allocated so it can flow to createStory unchanged. */
    bug?: BugDetail;
    /** Which engine produced the proposal. Useful for debugging + UI hints. */
    parser_engine: 'templated' | 'anthropic';
    /** Human-readable reasoning bullets — surfaces why the parser chose this kind. */
    rationale: string[];
}
export interface ParserOptions {
    /**
     * Force a kind. When provided, the parser's classifier is bypassed; only
     * extraction runs. Useful when the user explicitly clicks "+ Bug" or
     * "+ Epic" in the UI rather than relying on language detection.
     */
    forceKind?: ProposalKind;
    /** Disable the Anthropic call even if a key is configured (testing). */
    forceTemplated?: boolean;
}
export interface NLParser {
    parse(prompt: string, vision: VisionContextSummary, opts?: ParserOptions): Promise<Proposal>;
}
/**
 * Extract a sensible title from the first 6-8 words of the prompt with simple
 * cleanup (strip trailing punctuation, normalise whitespace, drop leading
 * pronouns when they are filler).
 */
export declare function extractTitle(prompt: string, kind: ProposalKind): string;
/**
 * Extract 2-3 acceptance criteria from action verbs in the prompt. Default
 * fallback: a generic "behaviour matches user intent" AC.
 */
export declare function extractAcceptanceCriteria(prompt: string, kind: ProposalKind, bug: BugDetail | undefined): string[];
/**
 * Match a prompt against existing epic titles using a simple word-overlap
 * heuristic. Returns the best-matching title or null when no overlap.
 *
 * Prefix-aware: "auth" matches "authentication" and vice versa, so a user
 * typing a colloquial short form still hits the corresponding epic.
 */
export declare function suggestEpic(prompt: string, epics: string[]): string | null;
/**
 * Run the templated parser. Pure function — no IO.
 */
export declare function parseTemplated(prompt: string, vision: VisionContextSummary, opts?: ParserOptions): Proposal;
/** Boot wires the driver here so the singleton picks it up on first construction. */
export declare function configureNLParserDriver(driver: AnthropicDriver | null): void;
/** Lazy singleton — same instance is reused across requests. */
export declare function getNLParser(): NLParser;
/** Test-only override. */
export declare function setNLParser(p: NLParser | null): void;
//# sourceMappingURL=nl-parser.d.ts.map