# Round 2 Fixes — Architecture

## Scope

Round 2 follow-up to the orbital boot DI / inbox-streaming / ops-helpers landing.
Two distinct pieces of work:

1. **Part A — Wire M1, M2, M6 ops helpers into the orchestrator boot path.**
2. **Part B — Fix three production bugs in the MCP streaming inbox flow.**

## Bounded contexts touched

- `orchestration/` (boot + worktree-cleanup wiring)
- `backlog/` (Monday reconciliation)
- `capabilities/` (key zeroization)
- `mcp/` (server.ts streaming dispatch + inbox_subscribe cursor source)
- `comms/` (inbox.ts cursor semantics: post_id vs event_id, lastConsumedCursor vs lastDeliveredCursor)
- `config/env.ts` (new optional env var: MONDAY_BOARD_ID)

No new bounded contexts. No new aggregates. No DSQL schema diff.

## Aggregate boundaries

- `task` aggregate is the source of TaskCompleted/TaskFailed events that drive worktree cleanup. No mutation of aggregate boundary; we just subscribe.
- `signing_keys` aggregate (capabilities) — KeyZeroizeService reads/writes it inside its own implementation; we only schedule the call at boot.
- `channel_post` aggregate — InboxMessage.cursor changes from post_id to event_id; the underlying ChannelPostAdded event already carries both, so this is a representation change, not an aggregate change.

## Event flow

### Existing flows (no change)

1. ChannelsService.post → emits ChannelPostAdded(event_id=E, payload.post_id=P)
2. EventStore.subscribe(cursor) yields envelopes with event_id (E) ordering
3. EventStore.backfillSince(afterEventId) compares against events.event_id
4. channel_posts.post_id is its own UUIDv7

### Cursor unification (BUG 3 fix)

- New rule: `InboxMessage.cursor` MUST equal the `event_id` of the corresponding ChannelPostAdded event.
- `postId` field stays as the channel_posts.post_id for downstream consumers.
- `readSince(cursor)` interprets `cursor` as event_id. Implementation joins channel_posts ↔ events on (aggregate_id = post_id) so the cursor is consistent.
- Consequence: cursor is comparable across the live stream (subscribe) and the backfill path (readSince).

### lastConsumedCursor (BUG 2 fix)

- Track `lastConsumedCursor` only when the consumer's `next()` resolves a message.
- buffer_truncated.lastDeliveredCursor MUST equal the cursor of the last message the consumer actually saw — null/empty if no message has yet been consumed.

## IAM / capability diff

None. No new scopes. No persona-of-record changes. The MCP streaming dispatch
respects the same scope checks the per-call router already enforces (the streaming
tool has bypassScopeCheck=true and validates per-channel inside its handler).

## Boot DI diff

`assembleOrchestration()` returns three new fields:

- `keyZeroizeService: KeyZeroizeService`
- `stopFns: Array<() => void | Promise<void>>` — additional shutdown handles
  collected during assembly (mondayReconcile, worktreeCleanup, keyZeroize).

The shutdown order in index.ts becomes:

```
stopInstrumentation
wsHub.stop
orchestration.shutdown            // runs the original shutdown (subscribers, mcpGateway)
                                   // shutdown internally walks stopFns LIFO so the
                                   // periodic timers stop before subscribers detach
app.close
closeDb
telemetry.shutdown
```

Per the user's specified order:
`instrumentation → wsHub → zeroize → worktreeCleanup → mondayReconcile → app.close → db.close → telemetry.shutdown`

## Streaming dispatch contract (BUG 1 fix)

Wire convention from protocol.ts §10.3 + clarified in the QA report:

1. Client sends a streaming request: `{ jsonrpc:'2.0', id:R, method:'inbox.subscribe', params:{...} }`.
2. Server invokes `tool.handler()` and writes a single response frame:
   `{ jsonrpc:'2.0', id:R, result: <stream_ready> }`
3. Server then drives `tool.streamHandler(input, ctx)` as an AsyncIterable.
   For each yielded value, server writes a notification frame:
   `{ jsonrpc:'2.0', method: '<tool.name>.event', params: <yield> }`  (no id field)
4. When the iterator returns or the consumer cancels the request, server writes
   a final response frame:
   `{ jsonrpc:'2.0', id:R, result: { closed:true } }`
5. On error, server writes `{ jsonrpc:'2.0', id:R, error:{ code, message, data } }`
   (the same id allows clients to terminate the stream).
6. On socket close mid-stream: invoke iterator.return() to run cleanup.

JSON-RPC purist note: a single id producing two `result` frames violates the
strict spec. The QA report and protocol comment-block both decree that we honor
this dual-result pattern (one initial stream_ready response + one final closed
response). Clients are expected to recognize the streaming method name. This is
a documented Orbital extension.

## Scheduler/spawn impact

None — the new wiring registers handlers and schedules; no scheduler changes.

## Blast radius

- BUG 1 fix — touches the gateway hot path. Mitigation: streaming dispatch is gated
  behind `tool.streaming === true && tool.streamHandler !== undefined`; non-streaming
  tools take the existing single-frame path verbatim.
- BUG 2 fix — touches inbox.ts buffer logic. Existing unit test asserting
  `droppedCount: 2` still passes; the NEW assertion is the contract for
  lastDeliveredCursor reflecting the consumer's last seen message.
- BUG 3 fix — InboxMessage.cursor changes value (event_id, not post_id). Service
  consumers that still depend on cursor==postId will break. Mitigation: postId
  stays as a separate field; only `cursor` semantics change. Both unit tests and
  Scenario 3 are updated.

## Rollback strategy

All changes are additive at the boot level (new helpers wired in; all guarded
with no-op fallbacks). The bug fixes are localized to two files (server.ts +
inbox.ts). Rollback is per-file revert.

The streaming dispatch in server.ts can be feature-flagged to off if needed
(by setting `tool.streaming` to false on inboxSubscribeTool); the existing
single-frame path remains untouched.

## Confidence

confidence: 96
rationale: Risk Tier = High (gateway hot path + boot DI changes), but the
implementation surface is small, the contracts are well-documented in
protocol.ts and the QA report, and there is an existing failing-by-design
regression test that becomes the verification anchor.
