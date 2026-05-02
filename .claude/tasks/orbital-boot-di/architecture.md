# Orbital Boot DI Graph — Architecture

## Bounded contexts touched

| Context | Modules touched | Direction |
|---|---|---|
| Boot/orchestration assembly | `src/index.ts`, **NEW** `src/orchestration/boot.ts` | added |
| Vision intake | `src/vision/service.ts`, `src/trpc/routers/vision.ts` | additive (Scheduler dep) |
| Retros | `src/retros/service.ts` | additive (Scheduler dep) |
| Sprint mutations | `src/index.ts` (registration only — service unchanged) | switch from readonly to real |
| tRPC DI registry | `src/trpc/routers/index.ts` | added Scheduler ref + lazy proxy |
| Hooks | `src/index.ts`, post-task hook factory wiring | added |

## Aggregate boundaries — invariants preserved

- **Sprint** (sprint-service.ts) — TRD-02 §6.1, §7.2: state machine sprint→{planning, ready, active, paused, completed} preserved. Real `DefaultSprintService` already enforces invariants; we only switch which instance is registered with the appRouter.
- **Vision document** (vision/service.ts) — TRD-01 §6.1, §12: lock/revise invariants unchanged. We add a `Scheduler` injection so `start()` actually fires `scheduler.addTask` for the PM persona session task. The synthetic-task pattern (using `documentId` as `task_id`, `vision-sprint-{documentId}` as `sprint_id`) is preserved verbatim.
- **Retro report** (retros/service.ts) — TRD-10 §7.3: report stays `'analyzing'` until persona finishes. We now also call `scheduler.addTask` on `analyze()` so a real worker is spawned (was capability-only before).
- **Verification** (verifiers/service.ts) — TRD-09 §10: SoD violation rule preserved (verifier persona ≠ executor). We wire post-task hook → `verifierService.spawnVerifier` so every TaskCompleted event spawns a verifier.

## Event flow (new wiring)

```
TaskCompleted    → eventStore.subscribe(null) → hookEngine.fire('post-task') → verifierService.spawnVerifier
SprintCompleted  → eventStore.subscribe(null) → retroService.analyze (existing path, but spawn now real)
StoryCreated     → optional syncService.onStoryCreated push to Monday (no-op if MONDAY token absent)
sprint.start UI mutation → real SprintService.start() → scheduler.addSprint + emit SprintStarted
vision.start UI mutation → VisionService.start() → scheduler.addTask({persona:'pm', ...}) + AgentSpawned event
retroService.analyze() → scheduler.addTask({persona:'retro-analyst', ...}) + AgentSpawned event
```

All events go through `EventStore.append`. No `db.insert(events)` anywhere.

## IAM (capability) diff

No new capability profiles introduced. Existing capability scopes used:

- PM persona spawn (`vision.start`): unchanged — already issues `channel_post:#vision-intake-{sessionId}`, no `files_write`. We now also enqueue a Scheduler task so the persona is *actually run*.
- Retro analyst (`retros.analyze`): unchanged — `board_read:'*'`, `channel_read:'#sprint-{sprintId}'`, `files_write:[]`. We now also enqueue a Scheduler task.
- Verifier (post-task hook): existing VerifierService.spawnVerifier issues no `files_write`; preserved.

## DSQL/schema diff

**None.** This is pure DI plumbing. No migration required.

## Blast radius

| Change | Blast radius |
|---|---|
| Replace readonly with real SprintService at boot | UI mutations now succeed; previously threw `STARTUP_ERROR`. Tests that relied on the readonly throwing must be reviewed (there are none — readonly was used only in production boot). |
| VisionService gets Scheduler param | Constructor signature change. Existing test `test/unit/vision/service.test.ts` only tests `validateForLock` and `VisionDocumentContentSchema` — no service construction; **no test break**. The router factory `getVisionService()` updated. |
| RetroService gets optional Scheduler in options | Existing tests construct `new DefaultRetroService(db, eventStore, authority, personaLoader, installId)` — positional args without options. We add the Scheduler to the options bag, so existing constructions are unaffected. |
| Post-task hook firing on TaskCompleted | New behavior at boot. If tests subscribe expecting NO post-task hook, they may see unexpected verifier spawns. Mitigation: the post-task hook only fires `spawnVerifier` when `payload.ready_for_verification === true && payload.task_id` — most events won't trigger it. |

## Rollback strategy

Single revert of the changed files restores prior behavior. Specifically:

1. `git revert` on the commit reverts `src/index.ts` to register `createReadOnlySprintService`.
2. `boot.ts` deletion has no consumers other than `index.ts`.
3. VisionService Scheduler param: optional in constructor — falling back to logging `pm spawn requested but no scheduler wired`.
4. RetroService Scheduler param: optional — degrades to capability-only (current Phase 5B behavior).

## Boot order in `boot.ts`

Strict dependency order — earlier services have no forward references:

```
1.  telemetry              (initTelemetry)
2.  install                (loadOrCreateInstall — needs filesystem)
3.  metricsRegistry        (registerMetrics)
4.  baseEventStore         (createEventStore)
5.  eventStore             (wrapAppend for tracing)
6.  stopInstrumentation    (startMetricsInstrumentation)
7.  keyManager             (KeyManager — needs install_id + eventStore)
8.  authority              (CapabilityAuthority — needs eventStore + keyManager)
9.  personaLoader          (DefaultPersonaLoader — needs db + eventStore)
10. routingEngine          (RoutingEngine — needs policy + catalog)
11. costAccounting         (CostAccounting — needs db + eventStore)
12. channelsService        (DefaultChannelsService — needs db + eventStore)
13. inboxService           (DefaultInboxService — needs db + eventStore)
14. ceremonyService        (DefaultCeremonyService — needs db + eventStore + channelsService)
15. blockerService         (DefaultBlockerService — needs db + eventStore + channelsService)
16. worktreeManager        (WorktreeManager — needs db)
17. workerMonitor          (WorkerMonitor — needs db + eventStore)
18. retryPolicy            (RetryPolicy — needs db + eventStore)
19. pauseController        (PauseController — needs db + eventStore + authority + personaLoader + installId)
20. mcpRegistry            (ToolRegistry + register tools + bootstrapOrchestrationRegistry)
21. scheduler              (DefaultScheduler — needs db, eventStore, authority, personaLoader,
                            routingEngine, worktreeManager, workerMonitor, pauseController, installId)
22. verifierService        (VerifierServiceImpl — needs eventStore + db; future: scheduler injection)
23. hookLoader             (HookLoader — needs db; loads baseline hooks)
24. hookEngine             (HookEngine — needs eventStore + db; register loaded + post-task)
25. realSprintService      (DefaultSprintService — needs db, eventStore, scheduler, pauseController, blockerService)
26. mondayClient           (createMondayClient — best-effort, requires env)
27. syncService            (createMondaySyncService — needs db, eventStore, mondayClient)
28. backlogService         (createBacklogService — needs db, eventStore)
29. uatService             (createUATService — needs db, eventStore, defectService, personaOfRecord)
30. retroService           (DefaultRetroService — needs db, eventStore, authority, personaLoader,
                            installId; new opts.scheduler injected)
31. agentOrgRepo           (createAgentOrgRepo — pure git-shell adapter)
32. proposalService        (createProposalService — needs db, eventStore, agentOrgRepo, installId)
```

After construction:

```
- registerSprintService(realSprintService)
- registerProposalService(proposalService)
- registerScheduler(scheduler)         [new — for vision router lazy DI]
- eventStore.subscribe(null, dispatch) [TaskCompleted → hookEngine.fire('post-task')]
- retroService.start()                 [subscribes to SprintCompleted internally]
- mcpGateway = createMCPGateway({...}) + mcpGateway.start()
- workerMonitor.start()
- wsHub.start()
- buildApp(...) + app.listen(...)
```

## Forced design choices documented

### C2 — VisionService.start: Scheduler.addTask vs scheduler.addSprint

The brief asks for `scheduler.addTask({persona, task_id, capability_scopes})`. The existing `Scheduler` interface has only `addSprint(s, tasks)` (no `addTask`). The two ways to spawn a single one-off persona task are:

- (A) Add a synthetic sprint with one synthetic task row → `scheduler.addSprint`. Heavy & noisy.
- (B) Use a "vision-sprint" sentinel sprint_id and insert a real `tasks` row directly; rely on the existing scheduler tick to pick it up.

I went with **(B)** — the tasks-table route — because it's the path the scheduler already understands without modification, it preserves capability issuance/spawn flow exactly as for normal tasks, and it follows the same pattern `BlockerService → SprintService.onRoute` uses for resolver tasks. Documented inline. The brief's "scheduler.addTask" API does not exist; the replacement is "insert tasks row + addSprint(synthetic, [])".

### C3 — RetroService spawn: same pattern

Same as C2 — RetroService now persists a synthetic `tasks` row with `personaId='retro-analyst'`, links to a sentinel `retro-sprint-{sprintId}`, and `scheduler.addSprint(sentinel, [])`. The existing scheduler tick allocates a slot and the spawn fires.

### C4 — Post-task hook subscription

`HookEngine.fire('post-task', payload, context, 'post')` requires payload + context. Subscribing to TaskCompleted via `eventStore.subscribe(null, ...)` lets us synthesize the payload from the event envelope (`task_id`, `ticket_id`, `artifact_paths`, `ready_for_verification`). The hook is fire-and-forget per spec — post hooks cannot retroactively un-persist the event.

### C1 — readonly-sprint-service.ts

Kept the file (no deletion) — still exported in case future scenarios need a read-only adapter. Production never instantiates it; only `DefaultSprintService` is registered.

## SoD enforcement

- Verifier spawn: `verifierService.spawnVerifier` already enforces `verifier persona !== acting persona` → `AUTH_SOD_VIOLATION`. Preserved.
- Cross-family review: this Engineer-Principal change to a Critical-tier boot path will require a non-Opus Code Review per SoD §3.

## Risk tier: Critical

Reason: changes the boot sequence and introduces real spawning at the boundaries of three subsystems (Vision, Retros, Verifiers). Sprint mutations move from "always-throw" to "production live". Tests must continue to pass.

## Confidence

`confidence: 95` — full DI graph mapped from existing factories; no new schema; tests preserved by additive-only constructor extensions; brief's `scheduler.addTask` API gap resolved with documented fallback to existing `addSprint + tasks-row` pattern.
