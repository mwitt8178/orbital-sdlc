/**
 * personas/anthropic-driver.ts — the canonical helper that every persona uses
 * to make a real Anthropic API call.
 *
 * Per Round5A spec. Refactored Round6 #8: low-level HTTP is now delegated to
 * drivers/anthropic.ts. This file remains a thin wrapper that preserves the
 * public AnthropicDriver / DefaultAnthropicDriver / createAnthropicDriver API
 * so existing import paths continue to work without change.
 *
 * ## Why a single driver
 *
 * Every persona that thinks (PM, retro analyst, NL parser, persona-of-record,
 * verifier) needs the same scaffolding:
 *
 * 1. select the right model via RoutingEngine.selectModel()
 * 2. assemble the system prompt (cached) + user prompt
 * 3. force structured JSON via tool-use
 * 4. parse + Zod-validate
 * 5. report cost via CostAccounting.report (emits CostReported)
 * 6. retry with exponential backoff on 429/5xx
 *
 * Centralising this here removes a class of bugs (forgotten cost reporting,
 * inconsistent prompt-cache strategy, ad-hoc JSON parsing) and makes the
 * call-site code in each persona small and readable.
 *
 * ## Stub fallback
 *
 * When ANTHROPIC_API_KEY is unset, the driver throws STARTUP_ERROR_NO_KEY at
 * `invoke()` time. Each persona catches that error and falls through to its
 * deterministic templated stub. This keeps the dev-mode behaviour identical
 * to today's experience.
 *
 * The driver itself does NOT contain a stub branch — failure is loud and
 * call-sites decide what to do (usually: fall back; sometimes: surface).
 *
 * ## Cost reporting
 *
 * Every successful invoke writes a row to `cost_accounting` and emits
 * `CostReported`. The session_id passed in is what the sprint cost meter
 * groups by. taskId/sprintId are what tasks cost-by-task / sprint-cost
 * dashboards group by. ticketId is optional metadata.
 *
 * @deprecated Direct low-level usage: prefer drivers/anthropic.ts. This
 *   wrapper is kept for backwards compatibility with existing persona call sites.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import type { CostAccounting } from '../routing/cost.js';
import type { RoutingEngine } from '../routing/engine.js';
import type { ModelId, RiskClass } from './types.js';
import type { AnthropicUsage } from '../routing/types.js';
import type { TaskId, SprintId } from '@orbital/types';
import type { EventStore } from '../events/store.js';
import type { Recorder } from '../replay/recorder.js';
/** Subset of the persona slug taxonomy that the driver uses for routing. */
export type DriverPersonaSlug = 'pm' | 'retro-analyst' | 'persona-of-record' | 'nl-parser' | 'verifier' | 'sr-dev' | 'principal-dev' | 'jr-dev' | 'qa' | 'em' | 'architect' | 'security' | 'scrum-master';
export interface DriverInvokeParams<T> {
    /** Persona requesting the call — used to drive routing affinity. */
    persona: DriverPersonaSlug;
    /**
     * Risk class for the call. Affects which model the routing engine picks
     * (high/critical may pin to a higher-tier model).
     */
    riskClass: RiskClass;
    /** Task this call belongs to (optional — some calls are not task-scoped). */
    taskId?: TaskId;
    /** Sprint this call belongs to (optional). */
    sprintId?: SprintId;
    /**
     * Session id used by CostAccounting to compute cumulative cost.
     *
     * Required because cost is grouped by session in the cost_accounting table.
     * Persona-of-record reasoning calls reuse the UAT session id; PM calls reuse
     * the vision session id; retro analyst reuses the retro report id; NL parser
     * uses a generated id since there is no longer-lived session.
     */
    sessionId: string;
    /** Optional ticket id for the cost row. */
    ticketId?: string;
    /** Optional turn index — defaults to a fresh uuidv7-derived integer. */
    turnIndex?: number;
    /** System prompt — heavily cached via cache_control on the system block. */
    systemPrompt: string;
    /** User prompt for this turn. */
    userPrompt: string;
    /**
     * Zod schema describing the structured output. The driver converts this to
     * a JSON Schema for tool-use forcing, then validates the model's response
     * against the same schema.
     */
    responseSchema: z.ZodType<T>;
    /** Optional JSON Schema override (for advanced cases zod-to-json-schema can't express). */
    jsonSchemaOverride?: Record<string, unknown>;
    /** Per-call max output tokens (default 4096). */
    maxTokens?: number;
    /** Per-call timeout in ms (default 60_000). */
    timeoutMs?: number;
    /** Trace id for log correlation. */
    traceId?: string;
}
export interface DriverInvokeResult<T> {
    /** Parsed + Zod-validated output. */
    result: T;
    /** Token usage from the SDK response. */
    usage: AnthropicUsage;
    /** Model that was actually used. */
    model: ModelId;
    /** Cost in USD micros (after CostAccounting.report). */
    costUsdMicros: number;
}
export interface AnthropicDriver {
    invoke<T>(params: DriverInvokeParams<T>): Promise<DriverInvokeResult<T>>;
    /** Round 6 #7 — late-attach a Recorder after construction. Optional. */
    setRecorder?(recorder: Recorder): void;
}
export declare class AnthropicDriverNoKeyError extends Error {
    constructor();
}
/**
 * Convert a Zod schema to a JSON Schema object suitable as a tool input_schema.
 *
 * Anthropic's tool-use accepts a subset of JSON Schema. We only need a small
 * piece — primitives, arrays, objects, optional/nullable, enum, union of
 * literals. Pulling in `zod-to-json-schema` would inflate the dep set;
 * implementing the converter here is ~80 lines and stays tightly scoped.
 *
 * Exported for testing.
 */
export declare function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown>;
export interface DefaultAnthropicDriverDeps {
    routingEngine: RoutingEngine;
    costAccounting: CostAccounting;
    installId: string;
    /**
     * Round 7-08 — Operator-Attributed UI
     * Human-readable display name for the install (e.g. "matt-laptop").
     * When provided, included in persona evidence prefixes and PR footers.
     * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
     */
    installDisplayName?: string;
    /**
     * Test seam — override the SDK constructor.
     * Passed through to the underlying CoreAnthropicDriver.
     */
    anthropicFactory?: (apiKey: string, timeoutMs: number) => Anthropic;
    /**
     * Optional event store for Round 6 #10 inspection events.
     * When provided, emits LLMRequestStarted + LLMRequestCompleted on each invoke.
     * When absent, no events are emitted (backwards-compatible).
     */
    eventStore?: EventStore;
    /**
     * Worker id for LLM inspection events.
     * When absent, 'unknown' is used as a safe fallback.
     */
    workerId?: string;
    /**
     * Round 6 #7 — Determinism / Replay
     * Optional Recorder for capturing the full LLM request + response so the
     * call can be deterministically replayed later. When absent, no capture
     * is recorded (backwards-compatible).
     * [Engineer-Principal · Opus · run-round6-07-replay]
     */
    recorder?: Recorder;
}
export declare class DefaultAnthropicDriver implements AnthropicDriver {
    private readonly routingEngine;
    private readonly costAccounting;
    private readonly installId;
    /**
     * Round 7-08 — Operator-Attributed UI
     * Display name for this install (e.g. "matt-laptop"). Used in persona evidence
     * prefix: `[matt-laptop · Engineer-Sr · Sonnet · run-X]`.
     * Falls back to abbreviated installId if not set.
     */
    readonly installDisplayName: string;
    /** The underlying driver from drivers/anthropic.ts handles HTTP + retries. */
    private readonly _coreDriver;
    /** Optional: emit LLM inspection events. Round 6 #10. */
    private readonly _eventStore;
    private readonly _workerId;
    /**
     * Optional: capture the full request/response for replay. Round 6 #7.
     * Mutable so boot.ts can attach a Recorder after the driver was already
     * constructed (resolves the chicken-and-egg between 3a driver creation
     * and 3d recorder creation).
     */
    private _recorder;
    constructor(deps: DefaultAnthropicDriverDeps);
    /**
     * Build the persona evidence prefix used in agent log output and event metadata.
     *
     * Format: `[<install-display-name> · <persona> · <model> · run-<runId>]`
     *
     * Round 7-08 — Operator-Attributed UI
     * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
     */
    buildPersonaPrefix(opts: {
        persona: string;
        model: string;
        runId?: string;
    }): string;
    /**
     * Attach a Recorder after the driver is already constructed. Allows boot.ts
     * to wire the replay subsystem without rebuilding the driver.
     * Round 6 #7 — Determinism / Replay.
     */
    setRecorder(recorder: Recorder): void;
    invoke<T>(params: DriverInvokeParams<T>): Promise<DriverInvokeResult<T>>;
}
export declare function createAnthropicDriver(deps: DefaultAnthropicDriverDeps): AnthropicDriver;
/**
 * Returns true when ANTHROPIC_API_KEY is set and non-empty. Call sites use
 * this to decide whether to attempt the real driver or go straight to the
 * templated fallback (e.g. to skip an unnecessary throw in hot paths).
 */
export declare function isAnthropicAvailable(): boolean;
//# sourceMappingURL=anthropic-driver.d.ts.map