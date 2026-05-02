# Round 7-04 — Real-Time Push From Hub To Clients
[Engineer-Sr · Sonnet · run-round7-04-realtime-push]

## TDD Cycle

### RED (tests written first)
- auth-handshake.integration.test.ts — AC5: 4001 on bad sig, unknown install, revoked
- subscribe-fanout.integration.test.ts — AC1: 500ms delivery, per-pattern fanout
- tenant-isolation.integration.test.ts — AC4: cross-tenant events not delivered
- reconnect-backfill.integration.test.ts — AC3: missed events delivered on reconnect
- test/hooks/useHubSubscription.test.tsx — S1-S14: store subscribe/dispatch/unsubscribe
- test/components/OfflineBanner.test.tsx — B1-B13: display logic + store integration

### GREEN (implementation)
All implementation files created. UI unit tests: 27/27 pass.
Integration tests require running Postgres — deferred to CI.

### REFACTOR (fixes applied)
- Fixed duplicate `const payload` declaration in subscriptions.ts matchesEvent()
- Added `SubscriptionRegistry.toSet()` public method (removed private field bracket access)
- Fixed `hub.ts` fanOut: removed incorrect root-level tenant_id check (payload.tenant_id is canonical)
- Fixed `hub.ts` backfill: use typed `EventStore.query()` (no cast needed)
- Fixed `reconnect-backfill.integration.test.ts`: tenant_id moved to payload (not root EventInput)
- Fixed `worker:*` pattern ordering bug: must check `=== 'worker:*'` before `startsWith('worker:') && endsWith(':*')` in all three files (subscriptions.ts, ws-client.ts, hubWs.ts) — 'worker:*' matched the broader branch and computed installId='' causing false negatives

## Self-Check

### DSQL/Multi-tenant
- No DSQL schema changes — events table not modified
- tenant_id travels via event.payload.tenant_id (confirmed: no tenant_id column in audit.events)
- matchesEvent() hard-checks tenant before any pattern matching
- OCC retry: N/A — no DSQL mutations in this feature

### Security
- WS upgrade auth via signed Ed25519 envelope (query params: install_id, sig, sig_body)
- Auth failure → close code 4001, not HTTP 401 (upgrade already happened)
- Nonce LRU replay protection (5min window, 10k cap)
- Revoked install check before signature verification

### Observability
- logger.debug on every connection open/close
- logger.debug on backfill count
- logger.warn on send failures, backfill failures

### Risk Tier
Estimate: M. Risk: Medium. Scope stayed within bounds.
No scope creep items.

## Deferred
- OfflineBanner DOM/accessibility tests deferred to Playwright (not jsdom)
- HubWsProvider wiring in App.tsx — caller's responsibility, not in scope for this ticket
- hub-client/index.ts re-export of ws-client — check on next run

---

## Deferreds resolved (followup run)
[Engineer-Sr · Sonnet · run-round7-04-realtime-push-followup]

### 1. Plugin double-registration fix

Root cause: `registerHubModeWsRoutes` in `packages/orchestrator/src/ws/server.ts` tried to
register `@fastify/websocket` itself inside a try/catch that swallowed
`FST_ERR_DEC_ALREADY_PRESENT`. All 4 integration test `beforeAll` blocks already called
`await app.register(websocketPlugin)` before calling `registerHubModeWsRoutes`, causing the
plugin to be registered twice. The swallow guard checked for `'already registered'` and
`FST_ERR_PLUGIN_ALREADY_LOADED` but the actual Fastify error code is
`FST_ERR_DEC_ALREADY_PRESENT`.

Fix: removed the plugin registration block entirely from `registerHubModeWsRoutes`. The
function now only registers the `/ws` route. The caller is responsible for registering
`@fastify/websocket` once before calling this function (all 4 tests already did this
correctly, and the real app boot must do so too). Updated the JSDoc to state this contract.

Additional fixes found during test run:
- `reconnect-backfill.integration.test.ts` used `actor: { type: 'system', component: 'backfill-test' }`
  which is not a valid `component` enum value — changed to `'orchestrator'`.
- `tenant-isolation.integration.test.ts` used `actor: { type: 'system', component: 'test' }`
  — same fix, changed to `'orchestrator'`.
- `auth-handshake.integration.test.ts` `attemptWsConnect` helper set `opened = true` in
  `ws.on('open')` before waiting for a hello ack, so auth-rejected connections (which open
  at TCP level then immediately close with 4001) were incorrectly reported as `opened: true`.
  Fixed by tracking `helloReceived` and only resolving `opened: true` after a hello ack
  arrives; a close before the ack resolves `opened: false`.
- `hub.ts` backfill ran twice (once on connect from URL cursor, once from subscribe-message
  cursor) causing `reconnect-backfill` to get 10 events instead of 5. Removed backfill call
  from `handleAuthenticatedConnection` — backfill now only runs when a `subscribe` message
  includes a cursor, at which point patterns are registered and the filter is meaningful.

### 2. UI integration sites

`packages/ui/src/pages/AgentInspector.tsx`:
- Imported `useHubSubscription` and `useQueryClient`.
- Added `useHubSubscription('worker:*', ...)` inside the component body.
- On `WorkerLifecyclePhase`, `ToolCallStarted`, `ToolCallCompleted`, `LLMRequestStarted`,
  `LLMRequestCompleted`, `WorkerKilledByOperator`, `AgentChannelPosted` events: invalidates
  `orchestration.workers.list` query and, when a drawer is open for that worker, also
  invalidates the `orchestration.workers.inspect` query.
- Also sets per-worker pulse state for the live-update dot in WorkerCard.

`packages/ui/src/components/features/uat/ACChecklist.tsx`:
- Imported `useHubSubscription`.
- Added `useHubSubscription('task:<taskId>', ...)` in the `ACChecklist` component body,
  enabled only when `taskId` prop is provided.
- On `VerifierEvidenceRecorded` or `CIRunCompleted` events: invalidates
  `uat.session.get` (pass/fail counts) and `uat.ac.evidence` (all AC evidence rows).

### 3. `team:presence` enum addition

Added `'presence'` to `AggregateTypeSchema` in `packages/types/src/event.ts`.
Removed the `as unknown as Record<string, unknown>` cast from the `team:presence` branch
in `packages/orchestrator/src/ws/subscriptions.ts`; now uses `event.aggregate_type`
directly. Rebuilt `@orbital/types` so orchestrator's tsc resolves the type correctly.

### Final verification output

```
Test Files  4 passed (4)
Tests  17 passed (17)
Duration  2.00s

grep useHubSubscription production sites: 2 ✓
grep 'presence' in packages/types/src/: packages/types/src/event.ts: 'presence' ✓
grep 'as.*team:presence': (empty) ✓
tsc --noEmit packages/types: clean ✓
tsc --noEmit packages/orchestrator: clean ✓
tsc --noEmit packages/ui: clean ✓
```
