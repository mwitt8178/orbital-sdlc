# Phase 2C — Orchestration Engine (Continuation) Architecture

## Persona Evidence
[Engineer-Principal · Opus · run-2c-cont]

## Bounded Contexts Touched
- **orchestration** (owner): scheduler, spawn, monitor, retry, pause, timeout, registry-bootstrap
- **mcp** (consumer): registers richer task.complete / task.fail handlers via registry-bootstrap
- **trpc** (new wiring): orchestration router + appRouter root
- **events** (consumer): every state change goes through EventStore.append
- **capabilities** (consumer): pause revokes; resume re-issues
- **routing** (consumer): selectModel called before each spawn

## Aggregate Boundaries
- `tasks` aggregate: owned by Scheduler. State machine transitions only inside scheduler/registry-bootstrap.
- `agent_workers` aggregate: owned by Scheduler.spawn() and WorkerMonitor. heartbeat updates owned by mcp/worker_heartbeat (already shipped).
- `worktrees` aggregate: owned by WorktreeManager (already shipped).
- `retry_attempts` aggregate: owned by RetryPolicy.
- `escalations` aggregate: owned by RetryPolicy on exhaustion.
- `worker_pool_state` (singleton): paused flag mutated by PauseController; `scheduler_epoch` bumped on every pause/resume edge.

## Event Flow (one task end-to-end)
1. Scheduler.tick selects feasible task → RoutingEngine.selectModel emits RoutingDecisionMade
2. CapabilityAuthority.issue → CapabilityIssued, CapabilityGranted
3. WorktreeManager.create (no event; recorded via row + drift reconciliation)
4. spawn() → AgentSpawned (via EventStore)
5. worker connects to MCP gateway, sends heartbeats → AgentHeartbeat (existing tool)
6. worker calls task.complete → TaskCompleted (via registry-bootstrap richer handler also mutates tasks → state='in_review' or 'done', sets completedAt)
7. CapabilityAuthority.revoke → CapabilityRevoked
8. WorktreeManager.cleanup (no event)

Failure path:
1. WorkerMonitor sees stale heartbeat → SIGTERM, AgentTimedOut
2. After 5s grace → SIGKILL, AgentFailed
3. RetryPolicy.recordFailure → RetryAttempted (×N)
4. On exhaustion → EscalatedToHuman + escalations row

Pause path:
1. PauseController.pause → set worker_pool_state.paused=true, bump scheduler_epoch, set agent_workers.status='draining' for sprint workers
2. Wait up to DRAIN_GRACE_MS (60s) for in-flight tasks to acknowledge drain (no new tool calls accepted; existing finish or are abandoned)
3. Revoke all sprint capabilities → CapabilityRevoked
4. OrchestrationPauseDrained event

Resume:
1. PauseController.resume → re-issue capabilities for ready tasks
2. clear paused flag, bump scheduler_epoch
3. OrchestrationResumeApplied event

## IAM / Capability Diff
No new scopes introduced. Pause path REVOKES via existing CapabilityAuthority.revoke. Resume path RE-ISSUES via existing CapabilityAuthority.issue with the same scopes (read from persona's defaultCapabilityProfile). No SoD changes.

## DSQL Schema Diff
None — all tables in 0006_orchestration.sql are already migrated. We only add code that READS / WRITES existing rows.

## Blast Radius
- Scheduler bug → entire daemon halts; no agents spawn. Easy to detect via metrics.
- Spawn bug → tasks stuck in 'ready'; manually resolvable.
- Monitor bug → orphan workers; manually resolvable via DB UPDATE on agent_workers.status.
- Pause bug → sprint stays paused; admin can manually clear `worker_pool_state.paused` and call scheduler.tick().

## Rollback Strategy
- Scheduler is process-internal; no migrations. Just revert and redeploy.
- Pause/resume is idempotent — bumping scheduler_epoch is monotonic so re-doing pause is safe.
- registry-bootstrap is called once at boot. If we need to roll back richer task.complete handler, simply omit the call from index.ts and the original Phase 2B handler remains.

## Multi-Sprint Scheduler — Weighted Equal-Share
- Internal state: `sprintDeficit: Map<SprintId, number>`. Initialized to 0 on addSprint.
- Each tick: among sprints with at least one ready+feasible task and at least one available slot:
  - Compute `share[s] = priority[s] / Σ priority[active]`
  - Pick sprint with maximum `(deficit[s] + share[s])`
  - Allocate 1 slot, then `deficit[picked] = (deficit[picked] + share[picked]) - 1`; for others, `deficit[other] += share[other]`
  - Repeat until no slots available or no feasible tasks
- Within a sprint, FIFO over `tasks.ordering ASC, created_at ASC`.

## File-Conflict Feasibility
- For a candidate task t with `declaredWritePaths = WP(t)`:
  - Define BUSY = ∪ over in-progress workers' tasks of WP(other) ∪ linked_artifacts paths.
  - Feasibility: `WorktreeManager.conflict(WP(t), BUSY) === false`.
- linked_artifacts are converted to filesystem paths only when their `type === 'file'`; other artifact types do not contribute conflicts.

## Spawn Surrogate Strategy (Tests)
- env.CLAUDE_BIN = process.execPath (node)
- spawn() always invokes `${CLAUDE_BIN} <claudeArgs...>`
- For tests: claudeArgs starts with the fake-worker.mjs path
- For production: claudeArgs is empty, real claude binary takes the env vars and sub-spawns subprocess as Claude Code expects

## Drain Approach (Stay Inside My Scope)
Per task brief, I do NOT modify mcp/router.ts. Instead:
- agent_workers.status='draining' is set by PauseController
- The richer task.complete/task.fail handlers from registry-bootstrap CHECK that the worker's row has status != 'draining'; if draining, return CONFLICT_INVALID_STATE.
- For other tools (heartbeat etc.), they continue to work — heartbeat lets the monitor know the worker is still alive while draining.

## Confidence: 92
Rationale: All interfaces from prior phases are fully read and understood. The novel parts — deficit accumulation, weighted equal-share, real ENOENT-clean spawn, drain coordination via worker status — are straightforward. The one area requiring care is the registry-bootstrap re-registration order (deregister before register) and the integration test's fake-worker bidirectional flow. Below the 95 threshold for High/Critical work because the integration test for spawn uses a real Unix socket connection from a child process, which can be flaky; I will use 5s timeouts and explicit close handlers to mitigate.
