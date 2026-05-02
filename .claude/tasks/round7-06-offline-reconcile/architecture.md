# Round 7-06 — Offline Cache + Reconciliation

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: L

## Depends on
7-02 (local-vs-hub split), 7-04 (real-time push)

## Why
Network drops happen. Hub deploys, ISP outages, coffee shop wifi. Operators must keep working — their local agents must keep running, their UI must stay browseable, their mutations must queue. When the hub is back, everything must reconcile cleanly without dupes or losses.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| NEW `hub-client/outbox.ts` | New | Persistent local queue: pending mutations + pending events when hub unreachable |
| `events/store.ts` | existing | Local-mode write succeeds even when hub is down; the outbox holds the hub-bound mirror |
| `hub-client/client.ts` (from 7-02) | existing | Connection state machine: `connected | reconnecting | offline`. Mutations during `offline` go to outbox. |
| `ws/ws-client.ts` (from 7-04) | existing | On reconnect, requests "events since last_seen_id" backfill before resuming push |
| `ui/src/state/cache.ts` | NEW (or extend React Query persistence config) | Persist last-known shared state to IndexedDB so UI stays browseable while disconnected |
| `ui/src/components/OfflineBanner.tsx` | NEW | The visible affordance |
| `ui/src/hooks/useHubConnection.ts` | NEW | React hook exposing connection state |
| NEW `db/schema/local-outbox.ts` | New | `local_outbox(seq, kind, payload, created_at, attempts, last_error)` — local-only table |
| NEW `db/migrations/0030_local_outbox.sql` | New | Schema |

## Reconciliation strategy
**Idempotency via event_id:** every event has a UUID generated locally. When the outbox flushes, the hub deduplicates by event_id (insert or skip). Same event_id sent twice = single hub row.

**Mutation idempotency:** every hub-bound mutation includes a client-generated `idempotency_key` (UUID). Hub deduplicates within a 24h window.

**Conflict resolution (last-writer-wins for v1):**
- Memory entry edited by both operators while one was offline → whoever flushes second wins on `(entry_id, updated_at)`.
- The losing operator's UI receives a notification: "your edit to 'Always use pino' was overridden by [matts-orbital] at 14:32. View their version | Restore yours"
- For task state (e.g., claim) the hub is authoritative — claim is a CAS (compare-and-swap on `claimed_by IS NULL`); offline-claim attempts may fail on flush.

## Outbox schema
```sql
CREATE TABLE IF NOT EXISTS local_outbox (
  seq          bigserial PRIMARY KEY,
  kind         text NOT NULL CHECK (kind IN ('event','mutation')),
  endpoint     text NOT NULL,        -- e.g. 'tasks.claim' or 'events.append'
  payload      jsonb NOT NULL,
  idempotency_key uuid NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  attempts     integer NOT NULL DEFAULT 0,
  last_error   text,
  flushed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS lo_pending_idx ON local_outbox (created_at) WHERE flushed_at IS NULL;
```

## Flush flow on reconnect
1. WS reconnects → connection state goes to `connected`.
2. Outbox worker picks up pending rows in seq order.
3. Each row sent to hub with idempotency_key.
4. On 200: mark `flushed_at`. On retriable 5xx: increment attempts, exponential backoff.
5. After all pending flushed: subscribe events backfill (request hub "events since last_seen_event_id").
6. Apply backfilled events to local cache.
7. Banner clears.

## Frontend UX
- Topbar dot (continuation from 7-04): green/yellow/red
- Persistent "Offline — N pending changes" banner when red, with "view pending" affordance
- "View pending" opens a panel showing each queued mutation with status (pending / retrying / failed)
- For mutations that fail permanently (e.g., claim conflict on flush): present a resolution UI ("the task was claimed by ricky-orbital; release your local claim?")

## Acceptance criteria
1. Disconnect hub for 60s. UI shows offline banner. Mutations during outage queue in `local_outbox`.
2. Reconnect. Within 10s all queued mutations flush in order; banner clears.
3. Idempotency: same event_id sent twice → single hub row. Verify with integration test.
4. Conflict: both operators edit same memory entry while one is offline; on reconnect, last-writer-wins; loser sees override notification.
5. Cache: with hub down, UI loads with last-cached task list, channels, memory entries. Read-only operations work; write operations queue.
6. Local agent continuity: a worker spawned while online continues running while hub is down. On reconnect, accumulated tool-call events flush to hub.
7. Failure visibility: a permanent flush failure (e.g., 422 from hub on a stale mutation) surfaces in the UI's pending panel with a resolution path.

## Hard-stop grep checks
```
grep -E "local_outbox" packages/orchestrator/src/db/schema/ -r
grep -E "OfflineBanner|useHubConnection" packages/ui/src/ -r | head
grep -E "idempotency_key" packages/orchestrator/src/hub-client/ -r
grep -E "flush|reconnect" packages/orchestrator/src/hub-client/outbox.ts
```

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]`
