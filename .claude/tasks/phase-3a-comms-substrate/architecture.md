# Phase 3A — Comms Substrate: Architecture

[Engineer-Principal · Opus · run-3a-comms]

## Bounded contexts touched

This task introduces a **single new bounded context**: `Comms`.

It is a peer to:
- `Events` (Phase 1A) — used as the **only** durable write path for new event types.
- `Capabilities` (Phase 1B) — used to gate `channel.post`, `channel.subscribe`, `inbox.subscribe`, `ceremony.statement`.
- `Personas` / `Routing` / `Orchestration` (Phase 2A/2B/2C) — used to spawn ceremony participants and blocker resolvers via `Scheduler` events; comms never reaches into orchestration internals.
- `MCP Gateway` (Phase 2B) — comms tools register on the same `ToolRegistry` and ride the same JSON-RPC newline transport.

## Aggregate boundaries (DDD)

| Aggregate root | Owned tables | Mutating tools / services |
|---|---|---|
| `Channel` | `channels`, `channel_subscriptions`, `pinned_posts`, `presence_indicators` | `ChannelsService.ensureChannel/subscribe`, `pin/unpin` |
| `ChannelPost` | `channel_posts`, `mentions`, `cross_references`, `cross_posts`, `reactions` | `channel.post`, `channel.cross_post`, `channel.react` |
| `Inbox` | (in-memory per-stream FIFO buffer; no table — backed by NOTIFY) | `inbox.subscribe`, `inbox.read_since` |
| `Blocker` | `blockers` | `blocker.raise`, `BlockerService.resolve/escalate` |
| `Ceremony` | `ceremonies`, `ceremony_participants`, `ceremony_outputs`, `ceremony_specifications` | `ceremony.schedule/start/recordTurn/vote/close` |
| `Disagreement` | `disagreements`, `tie_breaker_decisions` | `ConflictService.raise/resolve` |
| `ADR` | `adrs` | `ConflictService.writeAdr`, ceremony output (`output_kind='adr'`) |

`channel_post_types` is a runtime registry (lookup table) seeded at boot — not a per-request aggregate.

## Event flow

All listed events are written via `EventStore.append()` (never `db.insert(events)`).

**Inbound (consumed):**

- `AgentSpawned` (TRD-04) → `ChannelsService.computeDefaultSubscriptions()` → `ChannelSubscribed` events. Phase 3A subscribes via `EventStore.subscribe` and reacts asynchronously.
- `AgentCompleted` / `AgentFailed` (TRD-04) → mark `channel_subscriptions.unsubscribed_at`, write `ChannelUnsubscribed`, force-close any open inbox stream for that session.
- `TaskCreated` (TRD-04) → `ensureChannel('ticket_durable', ticketId)` + `ensureChannel('ticket_scratch', ticketId)`.
- `CapabilityDenied` (TRD-06, future) → auto-post to `#capability-violations`. Wired now; consuming subsystem adds in 3B.

**Outbound (emitted):**

| Event type | Aggregate type | Emitter |
|---|---|---|
| `ChannelCreated` | `channel` | `ChannelsService.ensureChannel` |
| `ChannelPostAdded` | `channel_post` | `ChannelsService.post` |
| `ChannelPostPinned` / `Unpinned` | `channel_post` | `pin/unpin` |
| `ChannelSubscribed` / `Unsubscribed` | `channel` | `subscribe/unsubscribe` |
| `MentionDelivered` | `channel_post` | `ChannelsService.post` (after fanout) |
| `ReactionAdded` / `Removed` | `channel_post` | `react/unreact` |
| `BlockerRaised` | `task` | `blocker.raise` MCP tool |
| `BlockerRouted` | `task` | `BlockerService.routeToResolver` |
| `BlockerResolved` | `task` | `BlockerService.resolve` |
| `BlockerEscalated` | `task` | `BlockerService.escalate` |
| `CeremonyScheduled` | `ceremony` | `CeremonyService.schedule` |
| `CeremonyStarted` | `ceremony` | `CeremonyService.start` |
| `CeremonyTurnTaken` | `ceremony` | `CeremonyService.recordTurn` |
| `CeremonyVoteCalled` | `ceremony` | `CeremonyService.callVote` |
| `CeremonyClosed` | `ceremony` | `CeremonyService.close` |
| `CeremonyAborted` | `ceremony` | `CeremonyService.abort` |
| `CeremonyOutputWritten` | `ceremony` | `CeremonyService.writeOutput` |
| `DisagreementRaised` | `disagreement` | `ConflictService.raise` |
| `TieBreakerAssigned` | `disagreement` | `ConflictService.assign` |
| `TieBreakerDecided` | `disagreement` | `ConflictService.decide` |
| `AdrPublished` | `adr` | `ConflictService.writeAdr` / ceremony output |

## IAM diff

No new capability scope keys. Existing scope grammar already includes `channel_read`, `channel_post`, `ceremony_role` (Primitives §6).

We **extend the `TOOL_TO_SCOPE_KEY` map** in `gateway.ts` to add:
- `channel.subscribe` → `channel_read`
- `inbox.read_since` → `channel_read`
- `ceremony.write_output` → `ceremony_role` (chair check via `required_role` param)
- `blocker.raise` → `channel_post` (gates on the originating ticket channel)
- `channel.thread.reply` → `channel_post`

`ceremony.statement` and `ceremony.call_closure` already map to `ceremony_role`.

For `inbox.subscribe`, we accept multiple channels — we validate `channel_read` against **each** channel name in the input list before opening the stream. Any denial fails the whole subscribe; partial subscriptions are not supported (per FR-5.9).

## DSQL schema diff

This project is **Postgres 16** (per CLAUDE.md and existing migrations), not DSQL. The DSQL hard-no list does not strictly apply here, but we honor the spirit:

- No foreign keys to `audit.events` (cross-schema ref by id only).
- No triggers on the new tables for application logic — append-only enforcement is delegated to the existing `audit.events` REJECT triggers and to application-layer state machines.
- Self-referencing FK on `channel_posts.parent_post_id` is added as `ON DELETE SET NULL` per TRD-05 §4.2.
- One in-table trigger added: `enforce_adr_immutability()` per TRD-05 §4.5.

### New tables (migration `0007_comms.sql`)

Total **18 new tables**. Idempotent `CREATE TABLE IF NOT EXISTS`. Each row uses UUIDv7 primary keys, `timestamptz`, JSONB for actor / payload / scope_ref.

`channels.ts` schema:
1. `channels` — pk `channel_id`, unique on `name`
2. `channel_posts` — pk `post_id`, self-FK on `parent_post_id`
3. `channel_post_types` — pk `post_type` (lookup; seeded at boot)
4. `channel_subscriptions` — pk `subscription_id`, partial idx where `unsubscribed_at IS NULL`
5. `mentions` — pk `mention_id`
6. `cross_references` — pk `cross_ref_id`
7. `cross_posts` — pk `cross_post_id`
8. `pinned_posts` — pk `pin_id`, unique partial idx where `unpinned_at IS NULL`
9. `reactions` — pk `reaction_id`, unique partial idx where `removed_at IS NULL`
10. `presence_indicators` — pk `presence_id` (the only mutable table)

`comms-workflow.ts` schema:
11. `blockers` — pk `blocker_id`
12. `ceremony_specifications` — pk `spec_id`, unique on `(ceremony_type, version)`
13. `ceremonies` — pk `ceremony_id`
14. `ceremony_participants` — pk `participant_id`, unique on `(ceremony_id, persona_role, session_id)`
15. `ceremony_outputs` — pk `output_id`
16. `disagreements` — pk `disagreement_id`
17. `tie_breaker_decisions` — pk `decision_id`
18. `adrs` — pk `adr_id`, unique on `adr_number`, immutability trigger

## Blast radius

- **Read path**: a slow inbox subscriber cannot back-pressure the whole gateway. The 256-msg per-stream FIFO buffer drops oldest envelopes and emits `buffer_truncated`. Worker recovers via `inbox.read_since(cursor)`.
- **Write path**: ceremony statement writes serialize via `pg_advisory_xact_lock(hashtext('ceremony:'||ceremony_id))` (TRD-05 §8.4). Distinct ceremonies do not contend.
- **Cross-post fan-out**: bounded to `target_channels.length ≤ 10` per call. Each derived post is a separate `channel_posts` row; no transaction spans more than ~12 inserts.
- **Blocker routing**: routes to a single resolver via `Scheduler.addTask` (or, if `addTask` is not exposed, by emitting a `TaskCreated`-like internal event that the existing scheduler picks up on next tick). Worst case: 0 resolvers available → after `max_routing_attempts=2` we escalate (`BlockerEscalated`).
- **WS hub**: per-connection filter; one slow client cannot block others. NOTIFY drain runs once per hub instance and fans out by Set lookup.

If the comms package fails to load at boot, only the Comms aggregate is unavailable; existing 263 tests in earlier phases continue to function. The orchestrator daemon does not require comms to be wired in `index.ts` for unit/integration tests in earlier phases — only Phase 3A's tests.

## Rollback strategy

1. **Migration rollback**: `0007_comms.sql` is purely additive (new tables, new trigger). Drop with:
   ```sql
   DROP TRIGGER IF EXISTS enforce_adr_immutability_trigger ON adrs;
   DROP FUNCTION IF EXISTS enforce_adr_immutability();
   DROP TABLE IF EXISTS reactions, pinned_posts, cross_posts, cross_references, mentions, channel_subscriptions, presence_indicators, channel_post_types, channel_posts, channels CASCADE;
   DROP TABLE IF EXISTS adrs, tie_breaker_decisions, disagreements, ceremony_outputs, ceremony_participants, ceremonies, ceremony_specifications, blockers CASCADE;
   ```
2. **Code rollback**: revert the commit. No earlier-phase modules import from `comms/` (they were not modified).
3. **TOOL_TO_SCOPE_KEY map extension**: a one-line revert in `gateway.ts` removes the new tool entries. We make this extension in a way that does NOT touch existing entries — additive only.
4. **Bootstrapping**: the 5 baseline topic channels (`#security-alerts`, `#architecture-decisions`, `#escalations`, `#capability-violations`, `#retro-feed`) are seeded by `ChannelsService.bootstrapBaseline()`. This is idempotent — re-runs are safe; rollback just stops calling it.

## WS hub design (real implementation, not a stub)

`WebSocketHub` registers with `EventStore.subscribe(null, handler)` once. On every event:
1. Filter to the `aggregate_type` set the hub cares about: `channel`, `channel_post`, `ceremony`, `disagreement`, `adr`, `task` (for blockers).
2. For each connected UI socket, check whether the event's channel/aggregate matches its subscribed set. The UI client sends a `subscribe` WS message with `{ channel_ids: [...], cursor }`; the hub maintains a per-conn `Set<channelId>` and `lastCursor`.
3. Send a canonical `WSMessage` (`ws_type='event'`) per Primitives §11.
4. Backpressure: per-conn outbound queue capped at 1000 msgs (matches TRD-05 §6.1.3 default). On overflow, send `ws_type='error'` with `BUFFER_TRUNCATED`, then drop intermediate events. Client must call `channel.posts.read` to resync (per TRD-05 §6.1.3).

The hub uses Fastify's `@fastify/websocket` plugin, registered in `ws/server.ts`. The plugin upgrades `GET /ws`. First WS message from the client must be a `subscribe` envelope (parsed against an internal `SubscribeRequestSchema`).

## Inbox streaming protocol (MCP)

The MCP gateway's existing `protocol.ts` is **request-response** JSON-RPC. We extend the convention (documented in protocol.ts comments) so that one outstanding `id` may produce **multiple `notification` frames** (JSON-RPC notifications, no `id`) followed by a final `response` (with the original `id`) when the stream closes.

Concretely:
- `inbox.subscribe` is dispatched normally through `routeMessage`.
- The handler does NOT return a value; instead, the gateway server (`server.ts`) is taught to recognize `inbox.subscribe` as streaming. The handler returns an `AsyncIterable<InboxStreamMessage>` and the server iterates, writing each as a JSON-RPC notification (`{ jsonrpc:'2.0', method:'inbox.event', params:<envelope> }`).
- On stream close (subscription unsub, capability revoked, worker disconnect): the server writes one final response `{ jsonrpc:'2.0', id, result:{ closed:true, reason } }` and closes the iterator.

This convention is documented in `protocol.ts` so `mcp/server.ts` can dispatch streaming tools differently from request-response tools. The existing 4 tools (heartbeat, complete, fail, request_help) all return a value; only `inbox.subscribe` is streaming.

## Backpressure buffer (256 msgs default)

`InboxService.subscribe(channelIds, cursor)` returns an `AsyncIterable<InboxMessage>`. Internally it:
1. Resolves channel ids/names to canonical ids.
2. Verifies `channel_read` for each (returns deny → throw `OrbitalError('AUTH_SCOPE_DENIED')`).
3. Subscribes to `EventStore` notify stream with `cursor`.
4. Maintains a `FIFOBuffer<InboxMessage>` (default cap 256, configurable via `buffer_cap` param ≤ 1024).
5. The async iterator pulls from the buffer; if the buffer fills (consumer not draining), drops oldest, increments `dropped_count`, schedules a single `BufferTruncated` envelope.
6. On overflow recovery, the consumer calls `inbox.read_since(channels, last_cursor)` to backfill from durable storage.

## Confidence

confidence: 95. Rationale: all surfaces are specified down to the SQL trigger and JSON-RPC notification convention. The only uncertainty is the precise tokenization library available — for the ceremony turn budget I plan to use `@anthropic-ai/tokenizer` if installed; if not, fall back to `Math.ceil(body.length / 4)` (rough heuristic) and document the substitution in a `NOTE:` comment. This satisfies the 95% threshold for Phase 3A High risk because every functional binary criterion has a concrete implementation path.

## What I will NOT touch

- `hooks/`, `verifiers/`, `db/schema/determinism.ts`, `db/migrations/0008*` (Phase 3B, parallel).
- `monday-comment-protocol` is irrelevant — this project's pipeline is local SDLC, not Monday-driven.
- I will NOT modify any earlier-phase module except `mcp/server.ts` (to add streaming dispatch) and `gateway.ts`'s `TOOL_TO_SCOPE_KEY` (additive only). Both modifications are minimal and surgical.

## Test plan summary

- **Unit (4 files)**: typed-post payload validation, FIFO buffer overflow + truncation, ceremony state-machine transitions, blocker state machine.
- **Integration (4 files)**: real Postgres for channel post lifecycle, blocker route-to-resolver, ceremony 3-participant happy path, real WebSocket end-to-end event delivery.
- All tests use UUIDv7 unique aggregates so `audit.events` REJECT triggers don't collide.

