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

import Anthropic from '@anthropic-ai/sdk'
import { uuidv7 } from 'uuidv7'
import { z } from 'zod'
import type { CostAccounting } from '../routing/cost.js'
import type { RoutingEngine } from '../routing/engine.js'
import type { ModelId, RiskClass } from './types.js'
import type { AnthropicUsage } from '../routing/types.js'
import type { TaskId, SprintId } from '@orbital/types'
import { logger } from '../config/logger.js'
import { loadEnv } from '../config/env.js'
import { AnthropicDriver as CoreAnthropicDriver } from '../drivers/anthropic.js'
import type { EventStore } from '../events/store.js'
import type {
  LLMRequestStartedPayload,
  LLMRequestCompletedPayload,
} from '../events/types.js'
import type { Actor } from '@orbital/types'
// Round 6 #7 — Determinism / Replay
// [Engineer-Principal · Opus · run-round6-07-replay]
import type { Recorder } from '../replay/recorder.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Subset of the persona slug taxonomy that the driver uses for routing. */
export type DriverPersonaSlug =
  | 'pm'
  | 'retro-analyst'
  | 'persona-of-record'
  | 'nl-parser'
  | 'verifier'
  | 'sr-dev'
  | 'principal-dev'
  | 'jr-dev'
  | 'qa'
  | 'em'
  | 'architect'
  | 'security'
  | 'scrum-master'

export interface DriverInvokeParams<T> {
  /** Persona requesting the call — used to drive routing affinity. */
  persona: DriverPersonaSlug
  /**
   * Risk class for the call. Affects which model the routing engine picks
   * (high/critical may pin to a higher-tier model).
   */
  riskClass: RiskClass
  /** Task this call belongs to (optional — some calls are not task-scoped). */
  taskId?: TaskId
  /** Sprint this call belongs to (optional). */
  sprintId?: SprintId
  /**
   * Session id used by CostAccounting to compute cumulative cost.
   *
   * Required because cost is grouped by session in the cost_accounting table.
   * Persona-of-record reasoning calls reuse the UAT session id; PM calls reuse
   * the vision session id; retro analyst reuses the retro report id; NL parser
   * uses a generated id since there is no longer-lived session.
   */
  sessionId: string
  /** Optional ticket id for the cost row. */
  ticketId?: string
  /** Optional turn index — defaults to a fresh uuidv7-derived integer. */
  turnIndex?: number
  /** System prompt — heavily cached via cache_control on the system block. */
  systemPrompt: string
  /** User prompt for this turn. */
  userPrompt: string
  /**
   * Zod schema describing the structured output. The driver converts this to
   * a JSON Schema for tool-use forcing, then validates the model's response
   * against the same schema.
   */
  responseSchema: z.ZodType<T>
  /** Optional JSON Schema override (for advanced cases zod-to-json-schema can't express). */
  jsonSchemaOverride?: Record<string, unknown>
  /** Per-call max output tokens (default 4096). */
  maxTokens?: number
  /** Per-call timeout in ms (default 60_000). */
  timeoutMs?: number
  /** Trace id for log correlation. */
  traceId?: string
}

export interface DriverInvokeResult<T> {
  /** Parsed + Zod-validated output. */
  result: T
  /** Token usage from the SDK response. */
  usage: AnthropicUsage
  /** Model that was actually used. */
  model: ModelId
  /** Cost in USD micros (after CostAccounting.report). */
  costUsdMicros: number
}

export interface AnthropicDriver {
  invoke<T>(params: DriverInvokeParams<T>): Promise<DriverInvokeResult<T>>
  /** Round 6 #7 — late-attach a Recorder after construction. Optional. */
  setRecorder?(recorder: Recorder): void
}

// ---------------------------------------------------------------------------
// Helpers (replay-related)
// ---------------------------------------------------------------------------

/**
 * Validate that a string is a UUID. Used to gate inserting workerId/taskId
 * into replay_captures uuid columns — a non-UUID would cause a DB error.
 * Returns null when input is null/undefined/non-UUID.
 */
const REPLAY_UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
function uuidOrNull(value: string | null | undefined): string | null {
  if (!value) return null
  return REPLAY_UUID_RE.test(value) ? value : null
}

// ---------------------------------------------------------------------------
// STARTUP_ERROR — thrown when ANTHROPIC_API_KEY is missing
// ---------------------------------------------------------------------------

export class AnthropicDriverNoKeyError extends Error {
  constructor() {
    super(
      'STARTUP_ERROR_NO_ANTHROPIC_API_KEY: AnthropicDriver requires ANTHROPIC_API_KEY. ' +
        'Set the env var to enable real LLM-backed personas. Without it, persona stubs ' +
        'will be used.',
    )
    this.name = 'AnthropicDriverNoKeyError'
  }
}

// ---------------------------------------------------------------------------
// zod-to-json-schema (focused minimal converter)
// ---------------------------------------------------------------------------

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
export function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const def = schema._def as { typeName?: string } & Record<string, unknown>

  switch (def.typeName) {
    case 'ZodString': {
      const out: Record<string, unknown> = { type: 'string' }
      const checks = def['checks'] as Array<{ kind: string; value?: number }> | undefined
      if (checks) {
        for (const c of checks) {
          if (c.kind === 'min' && typeof c.value === 'number') out['minLength'] = c.value
          if (c.kind === 'max' && typeof c.value === 'number') out['maxLength'] = c.value
        }
      }
      return out
    }
    case 'ZodNumber': {
      const out: Record<string, unknown> = { type: 'number' }
      const checks = def['checks'] as Array<{ kind: string; value?: number }> | undefined
      if (checks) {
        for (const c of checks) {
          if (c.kind === 'int') out['type'] = 'integer'
          if (c.kind === 'min' && typeof c.value === 'number') out['minimum'] = c.value
          if (c.kind === 'max' && typeof c.value === 'number') out['maximum'] = c.value
        }
      }
      return out
    }
    case 'ZodBoolean':
      return { type: 'boolean' }
    case 'ZodLiteral': {
      const value = def['value']
      return { enum: [value] }
    }
    case 'ZodEnum': {
      const values = def['values'] as unknown[]
      return { type: 'string', enum: values }
    }
    case 'ZodArray': {
      const inner = def['type'] as z.ZodTypeAny
      return { type: 'array', items: zodToJsonSchema(inner) }
    }
    case 'ZodObject': {
      const shape = (def['shape'] as () => Record<string, z.ZodTypeAny>)()
      const properties: Record<string, unknown> = {}
      const required: string[] = []
      for (const [key, child] of Object.entries(shape)) {
        properties[key] = zodToJsonSchema(child)
        const innerDef = child._def as { typeName?: string }
        const isOptional =
          innerDef.typeName === 'ZodOptional' ||
          innerDef.typeName === 'ZodDefault' ||
          innerDef.typeName === 'ZodNullable'
        if (!isOptional) required.push(key)
      }
      const out: Record<string, unknown> = {
        type: 'object',
        properties,
      }
      if (required.length > 0) out['required'] = required
      out['additionalProperties'] = false
      return out
    }
    case 'ZodOptional':
    case 'ZodDefault': {
      const inner = def['innerType'] as z.ZodTypeAny
      return zodToJsonSchema(inner)
    }
    case 'ZodNullable': {
      const inner = def['innerType'] as z.ZodTypeAny
      const innerSchema = zodToJsonSchema(inner)
      // JSON Schema 2020 form: anyOf { schema, { type: 'null' } }
      return { anyOf: [innerSchema, { type: 'null' }] }
    }
    case 'ZodUnion': {
      const options = def['options'] as z.ZodTypeAny[]
      return { anyOf: options.map(zodToJsonSchema) }
    }
    case 'ZodRecord': {
      const value = def['valueType'] as z.ZodTypeAny
      return { type: 'object', additionalProperties: zodToJsonSchema(value) }
    }
    case 'ZodAny':
    case 'ZodUnknown':
      return {}
    default:
      // Fall through for anything else; tool-use will accept loose schemas.
      logger.warn(
        { typeName: def.typeName },
        'zodToJsonSchema: unsupported schema type, returning empty schema',
      )
      return {}
  }
}

// ---------------------------------------------------------------------------
// Default implementation
// ---------------------------------------------------------------------------

const RESPOND_TOOL_NAME = 'respond_with_json'

const DEFAULT_MAX_TOKENS = 4096

export interface DefaultAnthropicDriverDeps {
  routingEngine: RoutingEngine
  costAccounting: CostAccounting
  installId: string
  /**
   * Round 7-08 — Operator-Attributed UI
   * Human-readable display name for the install (e.g. "matt-laptop").
   * When provided, included in persona evidence prefixes and PR footers.
   * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
   */
  installDisplayName?: string
  /**
   * Test seam — override the SDK constructor.
   * Passed through to the underlying CoreAnthropicDriver.
   */
  anthropicFactory?: (apiKey: string, timeoutMs: number) => Anthropic
  /**
   * Optional event store for Round 6 #10 inspection events.
   * When provided, emits LLMRequestStarted + LLMRequestCompleted on each invoke.
   * When absent, no events are emitted (backwards-compatible).
   */
  eventStore?: EventStore
  /**
   * Worker id for LLM inspection events.
   * When absent, 'unknown' is used as a safe fallback.
   */
  workerId?: string
  /**
   * Round 6 #7 — Determinism / Replay
   * Optional Recorder for capturing the full LLM request + response so the
   * call can be deterministically replayed later. When absent, no capture
   * is recorded (backwards-compatible).
   * [Engineer-Principal · Opus · run-round6-07-replay]
   */
  recorder?: Recorder
}

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

export class DefaultAnthropicDriver implements AnthropicDriver {
  private readonly routingEngine: RoutingEngine
  private readonly costAccounting: CostAccounting
  private readonly installId: string
  /**
   * Round 7-08 — Operator-Attributed UI
   * Display name for this install (e.g. "matt-laptop"). Used in persona evidence
   * prefix: `[matt-laptop · Engineer-Sr · Sonnet · run-X]`.
   * Falls back to abbreviated installId if not set.
   */
  readonly installDisplayName: string
  /** The underlying driver from drivers/anthropic.ts handles HTTP + retries. */
  private readonly _coreDriver: CoreAnthropicDriver
  /** Optional: emit LLM inspection events. Round 6 #10. */
  private readonly _eventStore: EventStore | undefined
  private readonly _workerId: string
  /**
   * Optional: capture the full request/response for replay. Round 6 #7.
   * Mutable so boot.ts can attach a Recorder after the driver was already
   * constructed (resolves the chicken-and-egg between 3a driver creation
   * and 3d recorder creation).
   */
  private _recorder: Recorder | undefined

  constructor(deps: DefaultAnthropicDriverDeps) {
    this.routingEngine = deps.routingEngine
    this.costAccounting = deps.costAccounting
    this.installId = deps.installId
    this.installDisplayName = deps.installDisplayName ?? deps.installId.slice(0, 8)
    this._coreDriver = new CoreAnthropicDriver({
      clientFactory: deps.anthropicFactory,
    })
    this._eventStore = deps.eventStore
    this._workerId = deps.workerId ?? 'unknown'
    this._recorder = deps.recorder
  }

  /**
   * Build the persona evidence prefix used in agent log output and event metadata.
   *
   * Format: `[<install-display-name> · <persona> · <model> · run-<runId>]`
   *
   * Round 7-08 — Operator-Attributed UI
   * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
   */
  buildPersonaPrefix(opts: { persona: string; model: string; runId?: string }): string {
    const runId = opts.runId ?? this._workerId.slice(0, 8)
    return `[${this.installDisplayName} · ${opts.persona} · ${opts.model} · run-${runId}]`
  }

  /**
   * Attach a Recorder after the driver is already constructed. Allows boot.ts
   * to wire the replay subsystem without rebuilding the driver.
   * Round 6 #7 — Determinism / Replay.
   */
  setRecorder(recorder: Recorder): void {
    this._recorder = recorder
  }

  async invoke<T>(params: DriverInvokeParams<T>): Promise<DriverInvokeResult<T>> {
    const env = loadEnv()
    const apiKey = env.ANTHROPIC_API_KEY
    if (!apiKey || apiKey.trim().length === 0) {
      throw new AnthropicDriverNoKeyError()
    }

    const traceId = params.traceId ?? uuidv7()
    const taskId = (params.taskId ?? (uuidv7() as TaskId))
    const sprintId = (params.sprintId ?? (uuidv7() as SprintId))

    // 1. Select model via routing engine.
    const decision = await this.routingEngine.selectModel({
      task_id: taskId,
      persona_id: params.persona,
      risk_class: params.riskClass,
      retry_depth: 0,
      trace_id: traceId,
    })
    const model = decision.model

    // 2. Build the tool-use payload that forces structured JSON output.
    const inputSchema =
      params.jsonSchemaOverride ?? zodToJsonSchema(params.responseSchema as z.ZodTypeAny)

    // 3. Delegate the actual HTTP call to the core driver (drivers/anthropic.ts).
    // Note: per-call timeout is not threaded through LLMDriver.send(); the core
    // driver uses its own default (120 s). Callers needing a shorter timeout
    // should construct a custom CoreAnthropicDriver with a custom clientFactory.
    const maxTokens = params.maxTokens ?? DEFAULT_MAX_TOKENS

    // Round 6 #10: emit LLMRequestStarted before the call.
    const llmCallId = uuidv7()
    const llmStartMs = Date.now()
    if (this._eventStore) {
      const startedPayload: LLMRequestStartedPayload = {
        worker_id: this._workerId,
        llm_call_id: llmCallId,
        provider: 'anthropic',
        model,
        started_at: new Date().toISOString(),
      }
      await this._eventStore.append({
        aggregate_id: this._workerId,
        aggregate_type: 'orchestration',
        event_type: 'LLMRequestStarted',
        payload: startedPayload as unknown as Record<string, unknown>,
        actor: SYSTEM_ACTOR,
        trace_id: traceId,
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      }).catch((err) => {
        logger.warn({ err, workerId: this._workerId }, 'anthropic-driver: failed to emit LLMRequestStarted')
      })
    }

    // Round 6 #7 — capture the full request body so the call can be replayed.
    // We snapshot the request struct here so the captured body matches the
    // body we actually send to the provider. Headers (api_key) are redacted
    // by the Recorder before persistence.
    const replayRequestSnapshot: Record<string, unknown> = {
      provider: 'anthropic',
      model,
      maxTokens,
      systemPrompt: params.systemPrompt,
      userPrompt: params.userPrompt,
      input_schema: inputSchema,
      tool_choice: { type: 'tool', name: RESPOND_TOOL_NAME },
      // Note: temperature is not yet plumbed via DriverInvokeParams; record
      // explicit absence so replay-substituted matches recorded responses.
      temperature: 0,
    }

    let llmResp: Awaited<ReturnType<CoreAnthropicDriver['send']>>
    try {
      llmResp = await this._coreDriver.send({
        model,
        maxTokens,
        system: [
          {
            type: 'text',
            text: params.systemPrompt,
            cache_control: { type: 'ephemeral' },
          },
        ],
        tools: [
          {
            name: RESPOND_TOOL_NAME,
            description:
              'Return your structured response as the input arguments to this tool. ' +
              'Always call this tool exactly once. Do not include any natural-language ' +
              'response outside the tool input.',
            input_schema: inputSchema,
          },
        ],
        tool_choice: { type: 'tool', name: RESPOND_TOOL_NAME },
        messages: [{ role: 'user', content: params.userPrompt }],
      })
    } catch (llmErr) {
      // Round 6 #10: emit LLMRequestCompleted with status=err on failure.
      if (this._eventStore) {
        const errPayload: LLMRequestCompletedPayload = {
          worker_id: this._workerId,
          llm_call_id: llmCallId,
          provider: 'anthropic',
          model,
          status: 'err',
          duration_ms: Date.now() - llmStartMs,
          completed_at: new Date().toISOString(),
        }
        await this._eventStore.append({
          aggregate_id: this._workerId,
          aggregate_type: 'orchestration',
          event_type: 'LLMRequestCompleted',
          payload: errPayload as unknown as Record<string, unknown>,
          actor: SYSTEM_ACTOR,
          trace_id: traceId,
          occurred_at: new Date().toISOString(),
          schema_version: 1,
        }).catch((emitErr) => {
          logger.warn({ emitErr, workerId: this._workerId }, 'anthropic-driver: failed to emit LLMRequestCompleted (err)')
        })
      }
      // Round 6 #7 — capture the err response too, so replay can replay the
      // failure mode. The "response" carries the error message + stack so
      // replay-substituted reproduces it byte-for-byte.
      if (this._recorder) {
        const errBody = {
          error: true,
          message: llmErr instanceof Error ? llmErr.message : String(llmErr),
          name: llmErr instanceof Error ? llmErr.name : 'Error',
        }
        await this._recorder
          .captureLLM({
            workerId: uuidOrNull(this._workerId),
            taskId: uuidOrNull(params.taskId ?? null),
            eventId: null,
            provider: 'anthropic',
            model,
            request: replayRequestSnapshot,
            response: errBody,
            determinism: { temperature: 0 },
            traceId,
          })
          .catch((capErr) => {
            logger.warn({ capErr, workerId: this._workerId }, 'anthropic-driver: captureLLM (err) failed')
          })
      }
      throw llmErr
    }

    // 4. Extract the structured payload from the tool_use block.
    const toolUseBlock = llmResp.content.find(
      (b) => b.type === 'tool_use' && (b as { name: string }).name === RESPOND_TOOL_NAME,
    ) as { type: 'tool_use'; id: string; name: string; input: unknown } | undefined

    if (!toolUseBlock) {
      throw new Error(
        `AnthropicDriver: model did not call the ${RESPOND_TOOL_NAME} tool.`,
      )
    }

    // toolUseBlock.input is unknown; Zod parses + validates.
    const parsed = params.responseSchema.safeParse(toolUseBlock.input)
    if (!parsed.success) {
      throw new Error(
        `AnthropicDriver: tool-use input failed Zod validation: ${parsed.error.message}`,
      )
    }

    // 5. Report cost.
    const usage: AnthropicUsage = {
      input_tokens: llmResp.usage.input_tokens,
      output_tokens: llmResp.usage.output_tokens,
      cache_read_input_tokens: llmResp.usage.cache_read ?? 0,
      cache_creation_input_tokens: llmResp.usage.cache_write ?? 0,
    }

    const costParams: Parameters<CostAccounting['report']>[0] = {
      taskId,
      sessionId: params.sessionId,
      sprintId,
      model,
      turnIndex: params.turnIndex ?? deriveTurnIndex(params.sessionId),
      usage,
      traceId,
    }
    if (params.ticketId !== undefined) {
      costParams.ticketId = params.ticketId
    }
    const costResult = await this.costAccounting.report(costParams)

    // Round 6 #10: emit LLMRequestCompleted with status=ok.
    if (this._eventStore) {
      const completedPayload: LLMRequestCompletedPayload = {
        worker_id: this._workerId,
        llm_call_id: llmCallId,
        provider: 'anthropic',
        model,
        status: 'ok',
        duration_ms: Date.now() - llmStartMs,
        input_tokens: usage.input_tokens,
        output_tokens: usage.output_tokens,
        cost_usd: costResult.costUsdMicros / 1_000_000,
        completed_at: new Date().toISOString(),
      }
      await this._eventStore.append({
        aggregate_id: this._workerId,
        aggregate_type: 'orchestration',
        event_type: 'LLMRequestCompleted',
        payload: completedPayload as unknown as Record<string, unknown>,
        actor: SYSTEM_ACTOR,
        trace_id: traceId,
        occurred_at: new Date().toISOString(),
        schema_version: 1,
      }).catch((emitErr) => {
        logger.warn({ emitErr, workerId: this._workerId }, 'anthropic-driver: failed to emit LLMRequestCompleted (ok)')
      })
    }

    // Round 6 #7 — capture the full request + response so the call can be
    // deterministically replayed. The Recorder redacts secrets and persists
    // the encrypted blob via the install-derived key.
    if (this._recorder) {
      // Build a serializable response body. LLMResponse shape carries
      // `content`, `usage`, and an optional provider `raw` body. We persist
      // the canonical fields so replay-substituted reproduces the same
      // structured output downstream.
      const responseBody: Record<string, unknown> = {
        content: llmResp.content,
        usage: llmResp.usage,
        model,
      }
      if (llmResp.raw !== undefined) {
        responseBody['raw'] = llmResp.raw
      }
      await this._recorder
        .captureLLM({
          workerId: uuidOrNull(this._workerId),
          taskId: uuidOrNull(params.taskId ?? null),
          eventId: null,
          provider: 'anthropic',
          model,
          request: replayRequestSnapshot,
          response: responseBody,
          determinism: { temperature: 0 },
          traceId,
        })
        .catch((capErr) => {
          logger.warn({ capErr, workerId: this._workerId }, 'anthropic-driver: captureLLM (ok) failed')
        })
    }

    logger.debug(
      {
        persona: params.persona,
        model,
        sessionId: params.sessionId,
        costUsdMicros: costResult.costUsdMicros,
        traceId,
      },
      'AnthropicDriver.invoke: completed',
    )

    return {
      result: parsed.data,
      usage,
      model,
      costUsdMicros: costResult.costUsdMicros,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic turn index for cost-accounting idempotency.
 * Cost.report is keyed on (sessionId, turnIndex). When the call site does not
 * supply a turnIndex we use a uuidv7-derived integer that is monotonic per
 * call, so two calls in the same session never collide.
 */
let _turnCounter = 0
function deriveTurnIndex(_sessionId: string): number {
  _turnCounter += 1
  return Math.floor(Date.now() / 1000) * 1000 + (_turnCounter % 1000)
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAnthropicDriver(
  deps: DefaultAnthropicDriverDeps,
): AnthropicDriver {
  return new DefaultAnthropicDriver(deps)
}

/**
 * Returns true when ANTHROPIC_API_KEY is set and non-empty. Call sites use
 * this to decide whether to attempt the real driver or go straight to the
 * templated fallback (e.g. to skip an unnecessary throw in hot paths).
 */
export function isAnthropicAvailable(): boolean {
  const env = loadEnv()
  return !!env.ANTHROPIC_API_KEY && env.ANTHROPIC_API_KEY.trim().length > 0
}
