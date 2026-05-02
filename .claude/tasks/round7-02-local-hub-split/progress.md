# Round 7-02 — Local-vs-Hub Split in Local Orbital
## [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]

**Risk Tier**: Medium (proxy routing, dual-write, new UI surface)
**Estimate**: L
**Date completed**: 2026-05-02

---

## Acceptance Criteria Evidence

### AC1 — hub-client module created
- `/packages/orchestrator/src/hub-client/types.ts` — HubTask, HubWorkerRegistration, HubProxyResult, HubClientOptions, HubConnectionStatus, HubEventInput
- `/packages/orchestrator/src/hub-client/client.ts` — HubClientImpl (HTTP POST to /trpc/<procedure>, batch format, x-orbital-tenant-id header), createHubClient(), createHubClientForTest()
- `/packages/orchestrator/src/hub-client/subscriptions.ts` — HubSubscriptionClientImpl (WebSocket, auto-reconnect 1s→30s, re-emits EventEnvelope)
- `/packages/orchestrator/src/hub-client/outbox.ts` — HubOutboxImpl (FIFO in-memory, drain loop, exponential backoff, drop after maxRetries)
- `/packages/orchestrator/src/hub-client/index.ts` — singleton (undefined=uninit, null=no-hub), getHubClient(), initHubClient(), resetHubClient()

### AC2 — tRPC routers hub-aware
Hub-proxied procedures (when ORBITAL_HUB_URL set):
- `orchestration.tasks.list` — HubTask→Drizzle-row camelCase mapping (all fields, nulls for absent)
- `orchestration.tasks.get` — same mapping for single task
- `channel.list` — typed ChannelListResult with kind: ChannelKind
- `memory.record`, `memory.get`, `memory.list` — typed with MemoryEntry / ListResult
- `retro.report.get` — typed RetroReportResult (full report + proposals shape)
- `prs.byTask` — typed PRShape
- `code_reviews.byPR` — typed ReviewEntry (comments_count: number, not nullable)
- `projects.list` — proxied

Local-only (unchanged): `orchestration.workers.*`, `cost`, `replay`, `inspection`, `admin`

### AC3 — scheduler reads from hub in hub mode
`/packages/orchestrator/src/orchestration/scheduler.ts` — `pickFeasibleTask` checks `getHubClient()` first; calls `hub.tasks.list(tenantId, sprintId)`, maps HubTask to TaskRow (personaId, riskClass, attemptCount, retryBudget, wallClockTimeoutMs, tokenBudget, declaredWritePaths). Falls back to local DB on hub failure.

### AC4 — spawn dual-writes worker registration
`/packages/orchestrator/src/orchestration/spawn.ts` — after local agentWorkers insert, calls `hub.workers.register(...)` when hub configured. Best-effort: hub failure logged as warn, local write authoritative.

### AC5 — audit middleware dual-writes events
`/packages/orchestrator/src/mcp/middleware/audit.ts` — `emitCapabilityDenied` accepts optional 7th param `hubOutbox?: HubOutbox | null`. After local EventStore.append, enqueues HubEventInput with local event_id as aggregate_id for idempotency.

### AC6 — UI: HubStatusIndicator
`/packages/ui/src/components/layout/HubStatusIndicator.tsx` — reads from useHubStore, returns null when hubUrl unset. Green dot+hostname=connected, amber+pulse=connecting, red=error/disconnected. Added to TopBar between LiveBurnWidget and SprintStatusPill.

### AC7 — UI: HubTab in Settings
`/packages/ui/src/components/features/settings/HubTab.tsx` — hub connection status card with colored border, "Test connection" button (fetches /health), local-vs-hub data table. Added to Settings page.

### AC8 — UI: trpc exports
`/packages/ui/src/services/trpc.ts` — exports `trpcLocal`, `trpcHub` alongside `trpc` (backwards-compat alias for trpcLocal). `createTrpcHubClient()` factory.

### AC9 — backwards compat
When ORBITAL_HUB_URL unset: getHubClient() returns null, all routers fall through to local Postgres. Confirmed by L1-L7 integration tests.

---

## TDD Cycle Evidence

### RED phase
- Wrote proxy-mode.integration.test.ts (P1-P7) — verified failing before hub-client existed
- Wrote local-fallback.integration.test.ts (L1-L7) — verified hub null path
- Wrote dual-write-events.integration.test.ts (D1-D6) — verified outbox behavior
- Wrote HubStatusIndicator.test.tsx (S1-S13) — pure helpers + store
- Wrote HubTab.test.tsx (T1-T14) — store + simulated fetch

### GREEN phase
- Implemented hub-client module, router proxies, scheduler/spawn/audit changes, UI components
- Fixed all TypeScript errors iteratively (see Fixes section below)

### REFACTOR phase
- Extracted type aliases for all hub proxy returns to prevent `unknown` widening
- Mapped HubTask→Drizzle row shape consistently to keep both code paths returning identical types
- Fixed outbox stop() to loop until queue empty (not just one drain pass)

---

## Fixes Applied During Implementation

1. `outbox.ts` — `this.queue[0]` TS18048: used `!` assertion with eslint disable comment
2. `subscriptions.ts` — EventEnvelope import: changed to `@orbital/types`; aggregate_type: used `as EventEnvelope['aggregate_type']` + `satisfies EventEnvelope`
3. `memory.ts list` — type widening: `type ListResult = Awaited<ReturnType<typeof memoryService.list>>`
4. `code-reviews.ts byPR` — ReviewEntry type: added explicit inline type with all fields
5. `prs.ts byTask` — PRShape type: added explicit type alias
6. `orchestration.ts tasks.list/get` — HubTask→Drizzle: comprehensive camelCase mapping with null fallbacks for storyId, ticketId, linkedArtifacts etc.
7. `channels.ts list` — kind: string not assignable to ChannelKind: typed ChannelListResult with `kind: ChannelKind`
8. `code-reviews.ts byPR` — comments_count possibly null: changed to `number` in type + `?? 0` in local path
9. `memory.ts get` — entry type unknown: typed with `MemoryEntry` (imported from memory/types.ts)
10. `retros.ts report.get` — report property missing: typed RetroReportResult with full shape
11. `local-fallback.test.ts` — ticketId notNull constraint: added `ticketId: 'TEST-0'`
12. `local-fallback.test.ts` — description notNull constraint: changed `null` to string value
13. `outbox.ts stop()` — D3 failure (queueDepth=1 after maxRetries): changed stop() to loop while queue.length > 0

---

## Self-Checks

### DSQL/multi-tenant
- All hub proxy calls pass tenantId via `ctx.tenantId` (tenantProcedure) or `env.ORBITAL_HUB_TENANT_ID` (publicProcedure)
- No tenant bleed: hub results scoped by tenantId on hub side; local fallback uses `eq(table.tenantId, ctx.tenantId)` guards unchanged
- No new DSQL mutations in this round (hub client uses HTTP, not direct DSQL)

### Security
- Hub client adds `x-orbital-tenant-id` header on every request
- Hub URL validated at init (must start with http/https)
- AbortSignal.timeout(10_000) on all hub fetch calls (no hanging connections)
- No secrets logged — hub client logs only status codes and error messages

### Observability
- Hub connection status changes logged at info level
- Hub proxy failures logged at warn with router name + error message
- Outbox drain failures logged at warn with event_id, event_type, retry count
- HubStatusIndicator surfaces connection state to operators in UI

### Backwards compat
- ORBITAL_HUB_URL unset → getHubClient() === null → all 8 router procedures fall through to local Postgres unchanged
- `trpc` export remains as alias for trpcLocal — zero UI callsite changes required

---

## Test Results

```
packages/orchestrator/test/integration/hub-client/proxy-mode.integration.test.ts   7/7 PASS
packages/orchestrator/test/integration/hub-client/local-fallback.integration.test.ts  7/7 PASS
packages/orchestrator/test/integration/hub-client/dual-write-events.integration.test.ts  6/6 PASS
packages/ui/test/components/HubStatusIndicator.test.tsx  13/13 PASS
packages/ui/test/components/HubTab.test.tsx  14/14 PASS

Total Round 7-02 tests: 47/47 PASS
```

TypeScript:
```
packages/orchestrator/tsconfig.json — 0 errors
packages/ui/tsconfig.json — 0 errors
```

Pre-existing failures (not introduced by Round 7-02, confirmed by isolation):
- sprint-service.test.ts pause/resume — OCC-related DB state issue (pre-existing)
- hygiene integration tests — DB state isolation issue (pre-existing)
- vision service/PM stub — pre-existing
- e2e tests (full-sprint, DR roundtrip, CBAC) — pre-existing

---

## Deferred
- Persistent outbox (survive restarts) — deferred to Round 7-06 as documented in outbox.ts comments
- Hub WS subscription auto-start — deferred to integration with app server start sequence (not in AC)
- `trpcHub` provider wiring to Settings URL — deferred (HubTab uses window.fetch for health check; trpcHub client configured but not yet mounted in providers)
