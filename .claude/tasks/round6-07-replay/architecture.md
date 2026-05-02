# Round 6 — #7 Determinism / Replay

## Persona / Risk
Engineer-Principal · Opus · Risk Tier: High · Estimate: L

(Risk High because correctness here underwrites the audit chain — wrong replay = wrong audit. Principal because cross-cuts events, hooks, drivers, gateway.)

## Why
`hooks/types.ts` only has a "pure function" comment. The event store is there, the hooks are deterministic by contract, but the explicit feature — "click an event, see the exact same prompt, tool calls, and output the agent produced" — doesn't exist. This is what makes an autonomous system auditable for SOC 2 and triageable post-incident. Without it, the audit trail is metadata, not reproducible truth.

## Independent of #1
Operates on existing event store + hooks layer. No file overlap with #1's spawn/post-task path. Could in principle run in Wave 1, but Risk-High → Principal model → run in Wave 3 to avoid blocking cheaper work.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `replay` (NEW) | `packages/orchestrator/src/replay/{service.ts,recorder.ts,player.ts,types.ts,store.ts}` | The replay domain |
| `events/store.ts` | existing | New event types: `ReplayCaptureStarted`, `ReplayCaptureCompleted`, `ReplayPlayed` |
| `personas/anthropic-driver.ts` | existing | Wrap each provider call: persist request+response to replay store (full prompt, tools, response, usage); emit ReplayCaptureCompleted referencing the saved blob |
| `mcp/gateway.ts` | existing | For each tool call, persist full input + output to replay store; tag with worker_id and a monotonic seq |
| `db schema` | NEW migration `0026_replay_capture.sql` | `replay_captures` table — keyed by capture_id; FK-style refs to event_id and worker_id |
| `replay/store.ts` | NEW | Storage abstraction. v1: filesystem at `~/.orbital/replays/<install_id>/<capture_id>.jsonl`; later: S3-compatible (Cloudflare R2 / MinIO local). |
| `trpc` | NEW `replay.ts` router | `replay.list({worker_id?, task_id?, event_id?})`, `replay.get({capture_id})`, `replay.replay({capture_id})` |
| `ui` | `pages/Audit.tsx`, NEW `components/features/audit/ReplayDrawer.tsx`, NEW `components/features/audit/ReplayDiff.tsx` | Click-to-replay any event |

## Data model
```sql
-- 0026_replay_capture.sql
CREATE TABLE IF NOT EXISTS replay_captures (
  capture_id      uuid        PRIMARY KEY,
  occurred_at     timestamptz NOT NULL DEFAULT now(),
  worker_id       uuid,
  task_id         uuid,
  event_id        uuid,                          -- the parent audit event this capture belongs to
  capture_kind    text        NOT NULL CHECK (capture_kind IN ('llm_request','tool_call','hook_invocation')),
  provider        text,                          -- 'anthropic','openai','bedrock' for llm_request
  model           text,
  request_hash    text        NOT NULL,          -- sha256 of canonical request JSON
  response_hash   text        NOT NULL,          -- sha256 of canonical response JSON
  storage_uri     text        NOT NULL,          -- file:///… or s3:// pointer to the full blob
  size_bytes      integer     NOT NULL
);
CREATE INDEX IF NOT EXISTS rc_worker_idx ON replay_captures (worker_id, occurred_at);
CREATE INDEX IF NOT EXISTS rc_task_idx ON replay_captures (task_id, occurred_at);
CREATE INDEX IF NOT EXISTS rc_event_idx ON replay_captures (event_id);
```

## Recording protocol (`replay/recorder.ts`)
- All callers go through a single `Recorder.capture()` API:
  ```ts
  recorder.capture({
    kind: 'llm_request',
    workerId, taskId, eventId,
    provider: 'anthropic', model: 'claude-sonnet-4-6',
    request: { /* full original request, including headers */ },
    response: { /* full body, headers, usage */ },
  }) -> captureId
  ```
- Storage:
  - JSON-Lines on filesystem: one line per capture, append-only, fsync on close.
  - File path: `~/.orbital/replays/<install_id>/<YYYY-MM-DD>/<capture_id>.json`
  - Encryption: encrypted with the install-level key (see `keys/` module from Phase 4) so replay blobs at rest are SOC 2 compliant.
  - The DB row stores the `storage_uri` and content hash. Hash mismatch on read = corrupt → emit `ReplayCorrupt` event.

## Determinism contract
- LLM requests: `temperature=0` strongly recommended for replay-able runs. Driver records both temp and seed. Replay does NOT promise byte-identical output for non-determinstic runs; the playback player notes "non-deterministic capture" and shows actual-vs-recorded diff.
- Tool calls: results are recorded; replay can substitute the recorded result, OR re-execute the tool against current state ("live re-run") — operator chooses.
- Hooks: pure-function contract is enforced by Round 5's hook-engine; replay injects same input → asserts same output.

## Player (`replay/player.ts`)
Three modes:
1. **Inspect** — render the captured request/response without re-running. Operator sees exactly what happened.
2. **Replay-substituted** — re-build the agent state, but feed recorded responses for each LLM/tool call. Useful to re-render decisions without spending tokens.
3. **Replay-live** — re-build the agent state and let it actually call the LLM/tools again. Compare new output vs recorded output side-by-side. Diffs surface non-determinism or environmental change.

## Frontend UX

### `pages/Audit.tsx` (extend existing)
- Each event row: if `replay_captures` exist for this event, show a 🔁 icon.
- Click → opens `<ReplayDrawer>` from the right.

### `ReplayDrawer.tsx` (new)
- Header: event_id, occurred_at, aggregate, capture summary
- Tabs:
  - "Request" — pretty-printed request (collapsible JSON)
  - "Response" — pretty-printed response (collapsible JSON)
  - "Replay" — three buttons: "Inspect", "Replay (substituted)", "Replay (live)"
  - "Diff" (only after Replay live) — side-by-side: recorded vs new, highlighting differences
- Footer: storage_uri (operator can verify integrity), content hash, blob size

### `ReplayDiff.tsx` (new)
- Token-level diff for text fields
- Object diff (added/removed/changed paths) for tool inputs/outputs
- Cost comparison: recorded usage vs new usage

### Audit page filter
- New filter: "Has replay capture" toggle

## Acceptance criteria
1. `grep -rE "from '.*replay/recorder'" packages/orchestrator/src/personas/anthropic-driver.ts` ≥1.
2. `grep -rE "from '.*replay/recorder'" packages/orchestrator/src/mcp/gateway.ts` ≥1.
3. Migration 0026 applies cleanly.
4. Integration test: spawn fake-worker → driver records a capture → replay.get returns it → hash verifies → blob roundtrips through the store.
5. Replay-substituted: re-run a captured agent flow → new output matches recorded output byte-for-byte (verifies determinism).
6. Encryption: blob on disk is unreadable without the install key — verified via test that opens the file and asserts non-JSON content.
7. UI: Audit page shows 🔁 icon on capturable events; ReplayDrawer renders without errors.

## What "wired up" means
- AnthropicDriver and gateway BOTH go through Recorder for every external call. Not "TODO: add later"; actually wired in the request path.
- Audit page IS importing ReplayDrawer.
- The `replay.replay(captureId, mode)` mutation actually executes — verified by integration test.

## Persona evidence prefix
`[Engineer-Principal · Opus · run-round6-07-replay]`
