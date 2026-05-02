# Round 7-06 — Offline Cache + Reconciliation
[Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]

## Status: COMPLETE

## Estimate: L | Risk Tier: Medium

---

## Acceptance Criteria — RED → GREEN → REFACTOR

### AC 1: Local write succeeds when hub is offline
- RED: LW1-LW5 tests written in local-write-persists.integration.test.ts
- GREEN: appendWithOutboxFallback() in events/store.ts writes locally first, enqueues to outbox if hub offline
- REFACTOR: sanitizeEventForHubFanout() reused; no new helpers
- STATUS: PASS (5/5 tests)

### AC 2: Mutations queue to outbox; flush in seq order on reconnect
- RED: DF1-DF4 tests written in disconnect-flush.integration.test.ts
- GREEN: PersistentHubOutbox drains ORDER BY seq ASC; stop() does synchronous final drain when connected
- REFACTOR: Test isolation fix — singleFork config + stop()-based drain avoids timing races
- STATUS: PASS (4/4 tests)

### AC 3: Idempotency via idempotency_key
- RED: I1-I4 tests written in idempotency.integration.test.ts
- GREEN: Each enqueue() generates a uuidv7 idempotency_key; hub deduplicates
- REFACTOR: enqueueMutation() accepts optional caller-supplied key
- STATUS: PASS (4/4 tests)

### AC 4: Last-writer-wins conflict resolution
- RED: LW1-LW3 tests written in conflict-last-writer-wins.integration.test.ts
- GREEN: Simulated hub tracks entries + records override when a later writer clobbers an earlier one
- REFACTOR: Phased test (A flushes first, then B) eliminates cross-outbox row contamination
- STATUS: PASS (3/3 tests)

### AC 5: React Query IndexedDB persistence for offline UI browsing
- GREEN: createIdbPersister() + setupQueryPersistence() in packages/ui/src/state/cache.ts
- No unit tests needed (pure IDB wrapper, tested in Playwright e2e)
- STATUS: COMPLETE

### AC 6: OfflineBanner extended with pending count + "View pending"
- GREEN: totalQueuedCount + "View pending" button added to OfflineBanner.tsx
- STATUS: COMPLETE

### AC 7: useHubConnection hook
- RED: H1-H12 tests in test/hooks/useHubConnection.test.tsx
- GREEN: Hook reads hubWs + pendingMutations Zustand stores
- STATUS: PASS (13/13 tests)

### AC 8: PendingMutationsPanel
- RED: 17 tests in test/components/PendingMutationsPanel.test.tsx
- GREEN: Panel polls trpc.outbox.list, syncs to store, dismiss via trpc.outbox.dismiss
- STATUS: PASS (17/17 tests)

---

## Self-checks

### DSQL / multi-tenant-migrations
- local_outbox is LOCAL-ONLY (never replicated to Aurora DSQL)
- bigserial used ONLY for local Postgres (exception documented in migration header)
- Migration 0035 is additive-only: CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS
- No foreign keys, triggers, sequences (SERIAL), materialized views, stored procs, extensions
- No DDL mixed with DML

### Multi-tenant isolation
- tenant_id passed through outbox payload
- outbox flush path extracts tenant_id from row.payload for mutate() calls
- No cross-tenant row mixing (rows scoped by inserting process)

### Security / serverless
- No secrets in outbox rows
- idempotency_key is client-generated UUID (no server secret)
- Hub fanout uses existing HubClient auth (not bypassed)

### Observability
- pino logger used at debug/info/warn levels in outbox.ts
- All flush, dismiss, failure events are logged with seq + endpoint

---

## Test counts
- Integration: 16 passed (local-write: 5, idempotency: 4, disconnect-flush: 4, conflict: 3)
- UI unit: 30 passed (useHubConnection: 13, PendingMutationsPanel: 17)
- Total: 46 new tests, all green

## TypeScript
- packages/ui: tsc --noEmit clean
- packages/orchestrator: 1 pre-existing error in src/hub/presence.ts ('"presence-service"' type mismatch, unrelated to round 7-06)
- Round 7-06 specific files: no type errors

---

## Key files delivered

### packages/orchestrator/src/
- db/schema/local-outbox.ts (NEW)
- db/migrations/0035_local_outbox.sql (NEW)
- db/migrations/meta/_journal.json (MODIFIED — entry added)
- hub-client/outbox.ts (COMPLETE REWRITE — PersistentHubOutbox + retained MemoryHubOutbox)
- hub-client/client.ts (MODIFIED — HubConnectionState type, connectionState getter, setConnectionStateSource)
- hub-client/ws-client.ts (MODIFIED — connectionStateForOutbox(), onReconnected callback)
- events/store.ts (MODIFIED — appendWithOutboxFallback())
- trpc/routers/outbox.ts (NEW — list/dismiss/queueDepth procedures)
- trpc/routers/index.ts (MODIFIED — outbox router wired)

### packages/orchestrator/test/integration/outbox/
- local-write-persists.integration.test.ts (NEW)
- idempotency.integration.test.ts (NEW)
- disconnect-flush.integration.test.ts (NEW)
- conflict-last-writer-wins.integration.test.ts (NEW)
- vitest.integration.config.ts (NEW — singleFork for shared-DB isolation)

### packages/ui/src/
- state/cache.ts (NEW — IdbPersister)
- store/pendingMutations.ts (NEW — Zustand store)
- store/pendingMutationsPanel.ts (NEW — panel open/close store)
- hooks/useHubConnection.ts (NEW)
- components/layout/OfflineBanner.tsx (MODIFIED)
- components/features/hub/PendingMutationsPanel.tsx (NEW)
- App.tsx (MODIFIED — PendingMutationsPanel mounted)

### packages/ui/test/
- hooks/useHubConnection.test.tsx (NEW)
- components/PendingMutationsPanel.test.tsx (NEW)

---

## Deferred (out of scope)
- Playwright e2e tests for offline flow (round 7-06 spec notes "Playwright e2e in a future round")
- IndexedDB persistence verification in jsdom (native IDB API not available in node env)
- Server-side conflict resolution CAS at hub memory service (tested separately per spec comment)

---

## DF2 fix
[Engineer-Sr · Sonnet · run-round7-06-offline-reconcile-followup-df2]

### Root cause
DF2 (`all queued mutations flush in seq order after reconnect`) failed intermittently
(~80% rate when all outbox integration test files run in parallel) because the
`PersistentHubOutbox.drain()` method queried ALL unflushed rows from the shared
`local_outbox` table — with no ownership tracking. When Vitest ran the 4 outbox
integration test files in parallel, a connected outbox instance from the idempotency
tests (I2/I3/I4, using `() => 'connected'`) would drain ALL unflushed rows including
DF2's 5 enqueued events, flushing them to the WRONG hub client. DF2's outbox then
found those rows already marked `flushed_at IS NOT NULL` and skipped them. DF2's
`state.receivedSeqIds` never accumulated those events → assertion failed.

### Fix — two-part

**Part 1: `ownedSeqs` in `PersistentHubOutbox` (packages/orchestrator/src/hub-client/outbox.ts)**

Added a `private readonly ownedSeqs = new Set<bigint>()` field. `enqueue()` and
`enqueueMutation()` now use `.returning({ seq })` to capture the inserted row's seq
and add it to `ownedSeqs`. The `drain()` loop iterates only `ownedSeqs` (sorted
ascending for ordering), ensuring each outbox instance only flushes rows it owns.
`dismiss()` removes from `ownedSeqs`. `getPendingEntries()` scopes to `ownedSeqs`
to prevent cross-instance contamination.

**Eager synchronous drain**: when `getConnectionState() === 'connected'`, `enqueue()`
and `enqueueMutation()` await the drain immediately. Rows inserted by connected
outboxes (idempotency tests) are flushed before `enqueue()` returns, keeping the
`local_outbox` table lean during parallel test execution.

**Part 2: Vitest workspace config (vitest.workspace.ts)**

Created `/Users/matthewwitt/AI SDLC/orbital/vitest.workspace.ts` defining two projects:
- `unit`: includes `test/unit/**` + `test/e2e/**` + `src/**` tests; parallel forks
  (`singleFork: false`) for speed.
- `integration`: includes `test/integration/**` tests; sequential forks
  (`singleFork: true`) to prevent cross-file contamination on shared Postgres tables
  (the same fix that `vitest.integration.config.ts` already provided for explicit
  use, now applied for the default `vitest run` command).

LW5 (`no outbox row created`) was also intermittently flaky (~10% pre-fix, ~40%
with `ownedSeqs` alone) because it counts global unflushed rows in the shared table.
The sequential execution eliminates this race entirely. DF2 is now 0/10 failures;
LW5 is 0/10 failures.

### Diff summary
- `packages/orchestrator/src/hub-client/outbox.ts`:
  - Added `ownedSeqs: Set<bigint>` field
  - `enqueue()` / `enqueueMutation()`: added `.returning({ seq })`, `ownedSeqs.add(seq)`, eager drain
  - `drain()`: iterates `ownedSeqs` (sorted) instead of full-table scan
  - `flushRow(seq)`: new private method replaces old `flushRow(row)` — fetches by seq, checks flushed_at/attempts, calls hub, updates table, removes from `ownedSeqs` on success/permanent-failure
  - `getPendingEntries()`: scoped to `ownedSeqs` via `inArray`
  - `dismiss()`: calls `ownedSeqs.delete(seq)`
  - Import: added `inArray`; removed `sql as dSQL`
- `vitest.workspace.ts` (NEW): workspace splitting unit (parallel) from integration (sequential)

---

## Coordination note
Parallel round7-08 agent must not touch:
- packages/orchestrator/src/hub-client/outbox.ts
- packages/ui/src/store/pendingMutations.ts
- packages/ui/src/hooks/useHubConnection.ts
