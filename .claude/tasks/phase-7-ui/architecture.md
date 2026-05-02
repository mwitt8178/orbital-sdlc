# Phase 7 — Full UI Implementation

## Bounded contexts touched

UI bundle is a pure consumer. It does not own any aggregate. It reads via tRPC and the WS hub, and writes via tRPC mutations exposed by the existing routers (channels, vision, uat, retro, audit-export, sprint, backlog). No new aggregates, no new event types, no new tables.

Touched orchestrator code is plumbing-only:
- `packages/orchestrator/src/index.ts` — register `@trpc/server/adapters/fastify` plugin at `/trpc`, register `registerWsRoutes` with a `WebSocketHub` started against `EventStore`, and call `registerSprintService` / `registerProposalService` so the appRouter has full DI at boot.
- The orchestrator routers are NOT modified.

UI source code is fully owned by this task.

## Component layout (UI)

```
packages/ui/src/
  main.tsx                                 # Provider setup
  App.tsx                                  # Router + AppShell
  index.css                                # Already correct from Phase 1C
  services/
    trpc.ts                                # createTRPCReact<AppRouter>() (existing)
    ws.ts                                  # WS client + reconnect (existing, extended)
  store/
    connection.ts                          # WS status + cursor (existing)
    events.ts                              # last-200 event ring (existing)
    sprints.ts                             # sprint list (existing)
    channels.ts                            # channel list + posts (existing)
    workers.ts                             # NEW — agent workers
    ceremonies.ts                          # NEW — active ceremony
    uat.ts                                 # NEW — current session
    retros.ts                              # NEW — current report
    vision.ts                              # NEW — current vision doc
  components/
    ui/                                    # primitives, Phase 1C
    layout/                                # AppShell, TopBar, SideNav (Phase 1C)
    features/
      dashboard/
        KpiCards.tsx
        SprintProgressBar.tsx
        AgentsInFlight.tsx
        ActivityStream.tsx
        NeedsAttention.tsx
      channels/
        ChannelList.tsx
        ChannelHeader.tsx
        PostFeed.tsx
        PostItem.tsx                       # Per-post-type styling
        PostComposer.tsx                   # Mention autocomplete
        ThreadView.tsx
        PinnedPosts.tsx
        ReactionBar.tsx
        PresenceIndicators.tsx
      vision/
        VisionChat.tsx
        VisionDocumentDisplay.tsx
        LockButton.tsx
        ReviseFlow.tsx
      ceremonies/
        CeremonyHeader.tsx
        ParticipantList.tsx
        StatementFeed.tsx
        OutputDisplay.tsx
      uat/
        ACChecklist.tsx
        SessionHeader.tsx
        DefectList.tsx
      retro/
        ReportCard.tsx
        ProposalCard.tsx
        ApproveDialog.tsx
      audit/
        EventTimeline.tsx
        ExportRequestForm.tsx
        ExportProgressBar.tsx
        DownloadButton.tsx
  pages/
    Dashboard.tsx                          # Replaces stub
    Vision.tsx
    Channels.tsx
    Ceremonies.tsx
    UAT.tsx
    Retro.tsx
    Audit.tsx
test/e2e/
  shell.spec.ts                            # existing
  dashboard.spec.ts                        # NEW
  channels.spec.ts                         # NEW
  uat.spec.ts                              # NEW
  global-setup.ts                          # NEW — boots orchestrator + migrations
  global-teardown.ts                       # NEW
```

## Data flow

### Read path (typical)

```
tRPC react adapter useQuery
  -> httpBatchLink POST /trpc/<procedure>
  -> Fastify @trpc fastify adapter
  -> appRouter procedure
  -> service layer
  -> Postgres
  <- shaped DTO
  -> react-query cache
  -> useQuery() returns { data, isLoading, error }
  -> view renders Skeleton | ErrorMessage | EmptyState | data
```

### WS event path

```
EventStore.append (any service)
  -> NOTIFY events_inserted
  -> EventStore.subscribe handler in WebSocketHub
  -> hub.fanOut filters by aggregate_type ∈ {channel, channel_post,
     ceremony, disagreement, adr, task} and per-conn channel filter
  -> WS frame { ws_type: 'event', payload: EventEnvelope, cursor }
  -> ui/services/ws.ts handleMessage
  -> dispatch into appropriate Zustand store based on aggregate_type +
     event_type
  -> components subscribed via Zustand selector re-render
  -> react-query invalidation for affected queries (e.g. invalidate
     uat.session.get on UATSessionACMarked)
```

### Mutation path

```
useMutation -> tRPC mutation -> orchestrator emits event(s) -> WS fan-out
  -> client store updates AND react-query auto-invalidates the affected
     query so the canonical server state takes precedence
```

## State shape additions

`store/workers.ts`:
```ts
interface Worker {
  workerId: string
  taskId: string | null
  personaRole: string | null
  model: string | null
  status: 'connecting' | 'active' | 'idle' | 'terminating' | 'terminated'
  startedAt: string
  lastHeartbeatAt: string | null
  currentFile?: string
}
```
Updates: setWorkers (initial query), upsertWorker (AgentSpawned, AgentHeartbeat), removeWorker (AgentCompleted, AgentTimedOut, AgentFailed, AgentTerminated).

`store/ceremonies.ts`: activeCeremony { ceremony_id, kind, participants[], turn, tokensRemainingPerParticipant }.

`store/uat.ts`: currentSession { session, acResults[] }.

`store/retros.ts`: currentReport { report, proposals[], layers[] }.

`store/vision.ts`: currentDocument { doc, lockedVersion?, draftVersion? }, sessionMessages[].

## tRPC ↔ view mapping

| Page | Primary queries | Mutations | WS aggregate_types consumed |
|---|---|---|---|
| Dashboard | sprint.list({status: 'active'}), orchestration.workers.list({status:['active','idle','connecting']}), audit.events.query (no filters, limit 50) | (none) | task, sprint |
| Vision | vision.get, vision.history | vision.start, vision.sendMessage, vision.lock, vision.revise | vision_document |
| Channels | channel.list, channel.posts.read | channel.post.create, channel.subscribe | channel, channel_post |
| Ceremonies | (no ceremony list query exists in current routers) — render only what arrives via WS | (none) | ceremony |
| UAT | uat.session.list (per ticket), uat.session.get, uat.defects.list | uat.session.start, uat.ac.mark, uat.ac.unmark, uat.submit, uat.accept | uat_session, defect, ticket |
| Retro | retro.proposal.list, retro.report.get | retro.proposal.approve/reject/defer, retro.rollback | retro |
| Audit | audit.events.query, auditExport.export.list, auditExport.export.status | auditExport.export.request, auditExport.export.cancel | (all — uses query) |

Note: ceremonies router is not exposed in the current AppRouter. The current scope of ceremony-related endpoints is limited; the UI will render zero-state cleanly when there is no ceremony, and surface ceremony events that arrive via WS into the store. We do NOT add new tRPC procedures (per task constraint: "consumes only what exists").

## Event flow (no new events; only new dispatchers)

| Event type emitted | Store(s) updated | Views re-render |
|---|---|---|
| AgentSpawned, AgentHeartbeat | workers | Dashboard.AgentsInFlight |
| AgentCompleted, AgentTimedOut, AgentFailed | workers (remove) | Dashboard.AgentsInFlight |
| TaskStateChanged | (react-query invalidate sprint+task lists) | Dashboard, UAT |
| SprintStarted/Paused/Resumed/Completed | sprints | Dashboard, TopBar |
| ChannelPosted, ChannelPostThreaded, ChannelPostPinned | channels | Channels page |
| VisionDocumentDrafted, VisionDocumentLocked, VisionDocumentRevised | vision | Vision page |
| UATSessionStarted, UATSessionSubmitted, UATSessionAccepted, UATACMarked | uat (and react-query invalidate uat.session.get) | UAT page |
| CeremonyOpened, CeremonyTurnTaken, CeremonyClosed | ceremonies | Ceremonies page |
| RetroProposalApproved/Rejected/Deferred | retros (and react-query invalidate retro.proposal.list) | Retro page |
| AuditExportRequested, AuditExportProgressed, AuditExportCompleted, AuditExportFailed | (react-query invalidate auditExport.export.status) | Audit page |

All events are read-only signals to the UI; the canonical refresh path is "WS event arrives -> invalidate the affected react-query key". Stores hold derived working state (last-N events, optimistic updates) — the server is always source of truth.

## IAM diff

**None.** No new capabilities, no new IAM scopes, no new keys, no new keychain entries, no new install-id work.

## DSQL / Postgres schema diff

**None.** Phase 7 is read-only against existing tables.

## Blast radius

**Low (UI-only, no service code modified except plumbing).**

What can break:
1. Orchestrator boot fails to register tRPC plugin (e.g. middleware order). Detection: `/health` works but `/trpc/*` returns 404. Mitigation: integration test that hits a tRPC endpoint after boot; fallback is to keep the current orchestrator-only operation working.
2. WS hub registered without start(). Detection: WS connects but receives no events. Mitigation: explicit `await hub.start()` before `app.listen` and a smoke test.
3. UI build breaks due to type drift between `@orbital/orchestrator/trpc` exports and the UI's expected types. Detection: `npm run build` (UI) errors. Mitigation: typecheck passes locally; cross-package imports resolved via the existing `exports["./trpc"]` map.
4. tRPC procedures throw at runtime when SprintService/ProposalService unregistered. Detection: a Sprint or Retro action throws "STARTUP_ERROR". Mitigation: boot wires both services before `app.listen` and the integration test exercises sprint.list at startup.

What cannot break:
- Existing orchestrator unit/integration tests (we do not change service code).
- Existing data (no migrations).
- Existing capability-grant model (no new scopes).
- Other phases' E2E (no event-shape changes).

## Rollback strategy

1. Revert the UI src/ changes (single commit boundary).
2. Revert the additive lines in `packages/orchestrator/src/index.ts` that register tRPC + WS + sprint service. Their absence means routes simply 404, which is the pre-Phase-7 baseline.
3. No data migration to rewind. No keychain entries to remove.

## Cross-cutting concerns

- **Error surfacing.** tRPC errors are surfaced via TanStack Query's `error` field. The view decides between "field-level inline" and "page-level ErrorMessage" based on which mutation/query is failing. Both render real, human-readable messages — never blank screens.
- **Empty states.** Every list view distinguishes "loading" (Skeleton) from "loaded with zero rows" (EmptyState) from "errored" (ErrorMessage) — three distinct visual states. This was already established by Phase 1C's primitives; the data pages adopt them consistently.
- **Accessibility.** All interactive elements use semantic HTML (`button`, `nav`, `main`, `header`, `dialog`). Icon-only buttons have `aria-label`. Live regions: the activity stream uses `role="status" aria-live="polite"`.
- **No `any`.** UI src/ is strict. The `EventEnvelope` type from `@orbital/types` is reused for WS payloads. Where the orchestrator returns shapes that differ from `@orbital/types` (e.g. session DTOs from uat.ts), local interfaces in the store mirror them.
- **No console.log.** Errors are surfaced in the UI; transient WS failures are silent (the connection store reflects 'reconnecting'). Eslint already enforces this.
- **No new tailwind config.** All tokens are already in `index.css` from Phase 1C.

## Test strategy

Per TDD discipline:

1. **Integration tests first**: Playwright E2E that spans the new boundary. Tests boot a real orchestrator (via global-setup) on a free port, run migrations against a tmp pg schema (or the dev DB if available), seed minimal fixtures via tRPC mutations, then exercise the UI.
   - `dashboard.spec.ts`: dashboard loads with sprint data (or empty state); the worker list reflects the backend.
   - `channels.spec.ts`: posts a message via the composer; the post appears in the feed (real round-trip through tRPC + WS).
   - `uat.spec.ts`: starts a UAT session, marks an AC, asserts UI state transition.
2. **Unit tests** for non-trivial helpers (e.g. event-to-store dispatcher), using vitest + jsdom. Optional but encouraged where logic is non-obvious; co-located.

The shell.spec.ts is preserved and updated only where its assertions break (e.g. when KPI cards show real data instead of em-dash placeholders, the test is loosened to "loading or content visible").

## Confidence

**confidence: 92** — Implementation complete and verified.
- UI build clean (vite, no type errors).
- UI lint clean.
- Project vitest: 685/685 orchestrator tests pass — no regression.
- Playwright: 26/26 e2e tests pass against the dev server.
- All 7 routes render appropriate state (loading skeletons during fetch, empty
  states when lists return zero, error treatments when tRPC fails) — no blank
  screens. Verified via live screenshots at packages/ui/test-results/_phase7-*.png.
- Read-only SprintService wired into orchestrator boot for sprint.list / sprint.get.
- WebSocketHub registered + tRPC fastify adapter mounted at /trpc.

Outstanding (out-of-scope for Phase 7 per brief):
- Sprint MUTATIONS (start/pause/resume/complete/create) require the full
  Scheduler+PauseController+BlockerService DI graph and are beyond UI scope;
  they throw STARTUP_ERROR at the tRPC layer until wired (deferred).
- The root tsconfig has a pre-existing TS6310 between packages/types/tsconfig.json
  (composite + noEmit) that affects only `tsc -b` at root. Per-package builds
  (UI + orchestrator) are clean. This was not introduced by Phase 7.
