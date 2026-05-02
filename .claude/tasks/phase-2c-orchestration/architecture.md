# Phase 2C — Orchestration Engine — Architecture

## Bounded contexts touched

This task owns the new `orchestration` bounded context. It composes (consumes-only) these neighbours:

- **events** (Phase 1A) — only via `EventStore.append`
- **capabilities** (Phase 1B) — only via `CapabilityAuthority.{issue,verify,revoke}`
- **personas** (Phase 2A) — only via `PersonaLoader.{get,getActive}` and `buildBrief()`
- **routing** (Phase 2A) — only via `RoutingEngine.selectModel`
- **mcp** (Phase 2B) — adds new tools to `ToolRegistry`; the gateway is owned by 2B and does not change

No table other than the new ones is mutated. `agent_workers` and `worker_heartbeats` already exist (Phase 2B) and are mutated only by the existing 2B handlers and by the new orchestration code through Drizzle (no schema redefinition).

## Aggregate boundaries

| Aggregate     | Owned tables                              | Lifecycle                                                                  |
|---------------|-------------------------------------------|----------------------------------------------------------------------------|
| Task          | `tasks`, `task_dependencies`              | TaskCreated → TaskAssigned → TaskStarted → (TaskCompleted | TaskFailed)    |
| RetryAttempt  | `retry_attempts`                          | One row per failed-then-retried attempt                                    |
| Escalation    | `escalations`                             | Open → acknowledged → resolved/cancelled                                   |
| Worktree      | `worktrees`                               | creating → active → draining → cleaning → released                         |
| WorkerPool    | `worker_pool_state` (single-row)          | Maintains global ceilings + paused flag + scheduler_epoch                  |

Worker rows (`agent_workers`) live in 2B's aggregate; we read them and update `status`, `taskId`, `pid`, `lastHeartbeatAt` only. The 2B-shipped tools (`worker.heartbeat`, `task.complete`, `task.fail`, `task.request_help`) emit events but do not mutate `tasks` — Phase 2C registers wrapper handlers that do that mutation transactionally with the event emission.

## Event flow

Task lifecycle events (all via EventStore.append):

```
sprint.start (TRD-02) ──► Scheduler.addSprint(sprint, tasks)
                          │
                          ├─► persist tasks (state=pending) + task_dependencies
                          ├─► emit TaskCreated for each task
                          └─► transition pred-free tasks → ready (no event)

Scheduler.tick() (every signal + 1s defensive):
  for each open worker slot, in priority order, while feasible:
     spawn(persona, task, capability, worktree)
     ├─ a) RoutingEngine.selectModel  → RoutingDecisionMade (TRD-08)
     ├─ b) CapabilityAuthority.issue  → CapabilityIssued + CapabilityGranted (TRD-06)
     ├─ c) WorktreeManager.create     → real `git worktree add`
     ├─ d) buildBrief(persona, task, capability)
     ├─ e) write capability.json @ {worktree}/.orbital/capability.json (mode 0600)
     ├─ f) insert agent_workers row(state=spawning)
     │     emit TaskAssigned
     ├─ g) update task.state=in_progress + current* fields
     │     emit TaskStarted
     ├─ h) child_process.spawn(CLAUDE_BIN, ...)
     │     handles ENOENT → AgentFailed(error=CLAUDE_BIN_NOT_FOUND)
     │     emit AgentSpawned

Worker calls task.complete (via MCP gateway, 2B):
  registry-bootstrap wraps the 2B handler — wrapper:
    ├─ emit TaskCompleted (via 2B handler)
    ├─ update tasks.state=in_review (Phase 2C addition)
    └─ emit AgentCompleted

WorkerMonitor (10 s poll):
  if now - last_heartbeat > 90s and worker.state=running:
     SIGTERM(pid), wait 5s, SIGKILL(pid)
     emit AgentTimedOut(timeout_kind=heartbeat)
     emit AgentFailed
     RetryPolicy.handle(task, error_code=TIMEOUT_HEARTBEAT)

RetryPolicy.handle(task, error):
  if attemptCount > retryBudget OR error in NON_RETRYABLE:
    insert escalations(reason=retry_budget_exhausted)
    update task.state=escalated
    emit EscalatedToHuman
  else:
    insert retry_attempts row
    increment task.attemptCount
    update task.state=ready
    emit RetryAttempted

Pause flow:
  PauseController.pause(sprintId):
    set worker_pool_state.paused (flag carried via in-memory map for sprint-scoped)
    bump scheduler_epoch
    update agent_workers.status='draining' for the sprint
    poll until tool_calls_in_flight=0 (heartbeat-driven) for ≤ 60s
    revoke all current capabilities for the sprint via CapabilityAuthority.revoke
    persist (worker_pool_state row)
    emit OrchestrationPauseDrained

Resume flow:
  PauseController.resume(sprintId):
    bump scheduler_epoch
    issue new capabilities via CapabilityAuthority.issue for ready/in_progress tasks
    clear paused flag
    enqueue via Scheduler
    emit OrchestrationResumeApplied
```

## IAM diff

No keychain or signing-key changes. Capability grants now:

- include the new `task_id` from a real `tasks` row (previously synthetic in 2B integration tests)
- are explicitly **revoked** during pause (new caller of `CapabilityAuthority.revoke`)
- are re-issued during resume (new caller of `CapabilityAuthority.issue`)

The Pause/Resume flow is the first production caller that revokes-then-reissues; this exercises the existing 1B `capability_revocations` table without modifying it.

## DSQL schema diff

This project uses **Postgres 16** (per docker-compose.yml), not DSQL. Migrations are pure SQL DDL. `0006_orchestration.sql` adds:

```
tasks(
  task_id PK, sprint_id, ticket_id, title, description, acceptance_criteria,
  story_id, monday_subitem_id, ordering, estimated_duration_ms, linked_artifacts,
  persona_id, risk_class, state CHECK(...) DEFAULT 'pending',
  attempt_count, retry_budget, parent_task_id,
  current_worker_id, current_capability_id, current_routing_decision_id, current_worktree_id,
  wall_clock_timeout_ms, token_budget, tokens_consumed,
  declared_write_paths jsonb DEFAULT '[]',
  created_at, started_at, completed_at, created_by_event_id
)
+ CHECK constraint: (state='in_progress') ⇔ (currentWorkerId+capability+worktree NOT NULL)
+ CHECK constraint: state IN ('pending','ready') ⇒ currentWorkerId IS NULL
+ CHECK constraint: attempt_count <= retry_budget + 1
+ index by (sprint_id, state), (ticket_id), (state), (story_id)

task_dependencies(
  predecessor_task_id, successor_task_id, dependency_type, blocking BOOL DEFAULT true,
  file_path_pattern, derived_from_ticket_link, rationale, created_at,
  PK(predecessor, successor)
)
+ CHECK self-edge forbidden

worktrees(
  worktree_id PK, task_id, path, branch_name, parent_branch,
  state CHECK in (creating,active,draining,cleaning,released),
  declared_write_paths jsonb, conflicts_with_worktree_id,
  created_at, released_at
)
+ unique partial index on task_id WHERE released_at IS NULL

retry_attempts(
  retry_attempt_id PK, task_id, attempt_number, triggered_by_event_id,
  error_code, routing_adjustment jsonb, decided_at
)

escalations(
  escalation_id PK, task_id, reason CHECK in (...), triggering_event_id,
  context jsonb, state DEFAULT 'open', resolved_at, resolution_note, created_at
)

worker_pool_state(
  id PK CHECK (id=1), max_concurrent_workers DEFAULT 8,
  max_active_sprints DEFAULT 3, paused BOOL DEFAULT false,
  paused_reason, paused_at, scheduler_epoch BIGINT DEFAULT 0
)
+ INSERT a single seed row
```

No triggers; no foreign keys to non-orchestration tables (cross-schema FKs across drizzle files are conceptual only — TRD-04 §4.1 reconciliation note).

## Blast radius

- **Code**: only files in the OWNED list. Existing 2B tools are wrapped via `registry-bootstrap.ts` — the original tools at `mcp/tools/*.ts` are not modified. `registry-bootstrap` defines a NEW `MCPTool` with the same `name` that calls the wrapped logic and adds the table mutation. Conflict: 2B's tools are still imported by the integration test; `registry-bootstrap` wraps them at registration-time so no source change to 2B.
- **DB**: only the seven new tables. Migrations are additive; the journal append (NOT overwrite) preserves prior entries.
- **Runtime**: when this code is *not* invoked (no Scheduler instance constructed at boot), it has zero effect on the existing daemon. Boot wiring is left for Phase 4B (which will instantiate the Scheduler and call `addSprint`).

## Rollback strategy

1. **Drop migration** — `0006_orchestration.sql` is reversible: each table is `CREATE TABLE IF NOT EXISTS`; rollback requires a paired `DOWN` script (out of scope for v1 per existing phases). Operationally, the rollback is to truncate the seven new tables (they are derived state — events table is the source of truth), then re-run the migration.
2. **Remove from registry** — `registry-bootstrap` is opt-in: the boot path in `index.ts` is unchanged in this phase. Until a later phase wires it in, the new wrapper handlers are not registered, and the 2B handlers remain authoritative.
3. **Worktrees on disk** — `WorktreeManager.cleanup` runs `git worktree remove --force` and is idempotent. A botched run leaves orphaned dirs at `~/.orbital/worktrees/{taskId}` — `git worktree prune` clears them.

## Confidence
- High/Critical risk-class threshold = 95 per Engineer-Principal hard rules.
- Confidence: 96.
- Rationale: TRD-04 v0.2 is comprehensive; the spawn protocol, scheduler algorithm, retry policy, pause/resume drain, and timeout watchdog are each individually specified to a level that lets the implementation be a faithful translation. Risk concentrations: (1) child_process.spawn semantics (mitigated by ENOENT handling + integration test with fixture worker), (2) git worktree operations on a fresh repo in tests (mitigated by initialising a tmp parent repo), (3) Drizzle cross-file references for pre-existing agent_workers (mitigated by importing the schema, not redefining), (4) test isolation under singleFork=false (mitigated by per-test unique aggregate_ids and unique tmp socket paths).

Authoritative review must confirm the registry-bootstrap wrap-vs-replace decision before scheduling cross-family code review.

