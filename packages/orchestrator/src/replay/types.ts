/**
 * replay/types.ts — domain types for the replay subsystem.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * The replay subsystem captures every external call (LLM + tool + hook)
 * the orchestrator makes. Each capture stores:
 *   - Metadata row in `replay_captures` (worker_id, task_id, hashes, URI, …)
 *   - Encrypted JSON blob at `storage_uri` (request + response, full bodies).
 *
 * Replay re-runs a captured flow in one of three modes — see ReplayMode below.
 * The promise: `replay-substituted` mode produces byte-identical output for
 * deterministic captures (temperature=0). This is the SOC 2 audit-correctness
 * primitive.
 */

// ---------------------------------------------------------------------------
// Capture kinds — what is being recorded
// ---------------------------------------------------------------------------

/**
 * What kind of external call this capture represents.
 *  - 'llm_request'      — provider invocation (Anthropic, OpenAI, Bedrock, …)
 *  - 'tool_call'        — MCP tool invocation
 *  - 'hook_invocation'  — pre-/post-event hook execution
 */
export type CaptureKind = 'llm_request' | 'tool_call' | 'hook_invocation'

// ---------------------------------------------------------------------------
// Replay modes
// ---------------------------------------------------------------------------

/**
 * Replay mode passed to Player.replay().
 *
 *  - 'inspect'             — render captured request/response without re-running.
 *  - 'replay-substituted'  — re-build agent state, feed RECORDED responses for
 *                            each LLM/tool call. No tokens spent. Deterministic
 *                            captures (temp=0) produce byte-identical output.
 *  - 'replay-live'         — re-build agent state, RE-CALL the LLM/tools
 *                            against current state. Surfaces non-determinism.
 */
export type ReplayMode = 'inspect' | 'replay-substituted' | 'replay-live'

// ---------------------------------------------------------------------------
// Capture body — the full blob persisted to disk
// ---------------------------------------------------------------------------

/**
 * The full payload persisted to the encrypted blob at storage_uri.
 * On disk, this object is JSON-stringified, encrypted with the install-derived
 * key, and the resulting bytes laid out as [salt | iv | ciphertext | tag].
 */
export interface CaptureBody {
  /** Same as the metadata row's capture_id; redundant for self-validation. */
  capture_id: string
  capture_kind: CaptureKind
  /** ISO8601 — when the capture was recorded. */
  occurred_at: string
  /** Provider id ('anthropic' | 'openai' | 'bedrock'); only set for llm_request. */
  provider?: string
  /** Model id; only set for llm_request. */
  model?: string
  /** Original worker that produced the call (nullable for system calls). */
  worker_id: string | null
  task_id: string | null
  /** The audit event id this capture is attached to (e.g. LLMRequestCompleted). */
  event_id: string | null
  /**
   * Full request as serializable JSON.
   * For llm_request: the full provider request body (system, messages, tools, …)
   *                  AFTER header/key redaction (no api_key, no Authorization).
   * For tool_call:   the JSON-RPC request including method + params.
   * For hook_invocation: the hook input.
   */
  request: Record<string, unknown>
  /**
   * Full response as serializable JSON.
   * For llm_request: the provider response (content blocks, usage, stop_reason).
   * For tool_call:   the JSON-RPC response (result or error).
   * For hook_invocation: the hook output (decision + side effects).
   */
  response: Record<string, unknown>
  /**
   * Captured determinism context — temperature, seed, model version, etc.
   * Used by replay-live mode to set up an equivalent call.
   */
  determinism?: {
    temperature?: number
    seed?: number
    [key: string]: unknown
  }
}

// ---------------------------------------------------------------------------
// Recorder input
// ---------------------------------------------------------------------------

/**
 * Parameters passed to Recorder.capture(). The recorder generates the
 * capture_id, computes hashes, persists the blob, writes the metadata row,
 * and emits ReplayCaptureCompleted.
 */
export interface CaptureInput {
  kind: CaptureKind
  workerId: string | null
  taskId: string | null
  eventId: string | null
  /** 'anthropic' | 'openai' | 'bedrock' (only for llm_request). */
  provider?: string
  model?: string
  /** Full request body — should already be redacted (no api keys, etc.). */
  request: Record<string, unknown>
  /** Full response body. */
  response: Record<string, unknown>
  determinism?: CaptureBody['determinism']
  /** Optional trace id to correlate with the parent audit events. */
  traceId?: string
}

// ---------------------------------------------------------------------------
// Capture record (DB-shape, returned to callers)
// ---------------------------------------------------------------------------

export interface CaptureRecord {
  capture_id: string
  occurred_at: string
  worker_id: string | null
  task_id: string | null
  event_id: string | null
  capture_kind: CaptureKind
  provider: string | null
  model: string | null
  request_hash: string
  response_hash: string
  storage_uri: string
  size_bytes: number
}

// ---------------------------------------------------------------------------
// Replay result
// ---------------------------------------------------------------------------

export interface ReplayResult {
  capture_id: string
  mode: ReplayMode
  /** The captured request that was re-played. */
  recorded_request: Record<string, unknown>
  /** The captured response. */
  recorded_response: Record<string, unknown>
  /**
   * The result from running the request again (replay-live) OR the recorded
   * response substituted in (replay-substituted) OR null (inspect).
   */
  replay_response: Record<string, unknown> | null
  /** True when the replay_response hash matches recorded_response hash. */
  matched_hash: boolean
  /** Duration of the replay invocation in ms. */
  duration_ms: number
  /** When the replay was executed. */
  played_at: string
}
