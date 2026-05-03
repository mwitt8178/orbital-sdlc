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
export {};
//# sourceMappingURL=types.js.map