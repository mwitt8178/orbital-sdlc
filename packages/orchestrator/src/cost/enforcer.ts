/**
 * cost/enforcer.ts — CostEnforcer: pre-spawn budget check + live kill switch.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 *
 * Flow (pre-spawn):
 *   canSpawn(projectId, sprintId?, estimatedTokens?)
 *     → sum cost_ledger for the narrowest configured scope
 *     → if running + estimated > hard_cap → { allow: false, action: 'pause' }
 *     → if running + estimated > soft_threshold → { allow: true, warn: true }
 *     → else { allow: true }
 *
 * Flow (post-call live check):
 *   checkLive(projectId, sprintId?)
 *     → if running > hard_cap AND on_hard === 'kill' → emit KillSwitchTripped + SIGTERM all workers
 */

import { eq, and, sql as dSQL } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import type { CostService } from './service.js'
import { computeCostUsd } from './pricing.js'
import type { EnforcerResult, CanSpawnParams } from './types.js'
import { agentWorkers } from '../db/schema/worker-tables.js'
import { tasks } from '../db/schema/orchestration.js'
import { logger } from '../config/logger.js'
import type { KillSwitchTrippedPayload, BudgetExceededPayload } from '../events/types.js'
import type { Actor } from '@orbital/types'

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

// Default cost estimate when caller doesn't supply token counts.
const DEFAULT_ESTIMATED_INPUT_TOKENS  = 10_000
const DEFAULT_ESTIMATED_OUTPUT_TOKENS = 2_000

// ---------------------------------------------------------------------------
// CostEnforcer
// ---------------------------------------------------------------------------

export class CostEnforcer {
  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
    private readonly costService: CostService,
    /** Inject for tests. Defaults to process.kill. */
    private readonly killFn: (pid: number, signal: NodeJS.Signals) => void = (pid, sig) =>
      process.kill(pid, sig),
  ) {}

  /**
   * Check whether a spawn is allowed given the current running cost
   * and the estimated cost of the task about to be launched.
   *
   * Checked scopes (most-specific first): sprint, project, install.
   * Returns the most restrictive result across all configured budgets.
   */
  async canSpawn(params: CanSpawnParams): Promise<EnforcerResult> {
    const { projectId, sprintId, taskId } = params

    const estimatedInput  = params.estimatedInputTokens  ?? DEFAULT_ESTIMATED_INPUT_TOKENS
    const estimatedOutput = params.estimatedOutputTokens ?? DEFAULT_ESTIMATED_OUTPUT_TOKENS
    // Use sonnet pricing as a conservative default for pre-spawn estimation.
    const estimatedCostUsd = computeCostUsd('claude-sonnet-4-6', {
      inputTokens:  estimatedInput,
      outputTokens: estimatedOutput,
    })

    // Check sprint-scope budget (most specific).
    if (sprintId) {
      const budget = await this.costService.getBudget('sprint', sprintId)
      if (budget) {
        const runningCostUsd = await this.costService.getRunningCost('sprint', sprintId)
        const result = this._evaluate(runningCostUsd, estimatedCostUsd, budget.hardCapUsd, budget.softThresholdPct)
        if (!result.allow) {
          logger.warn(
            { projectId, sprintId, taskId, runningCostUsd, estimatedCostUsd, hardCap: budget.hardCapUsd },
            'CostEnforcer.canSpawn: sprint budget exceeded — blocking spawn',
          )
          await this._emitBudgetExceeded('sprint', sprintId, runningCostUsd, budget.hardCapUsd, uuidv7())
          return result
        }
        if (result.warn) {
          logger.warn(
            { projectId, sprintId, runningCostUsd, hardCap: budget.hardCapUsd },
            'CostEnforcer.canSpawn: sprint budget soft threshold crossed',
          )
        }
        return result
      }
    }

    // Check project-scope budget.
    const projectBudget = await this.costService.getBudget('project', projectId)
    if (projectBudget) {
      const runningCostUsd = await this.costService.getRunningCost('project', projectId)
      const result = this._evaluate(runningCostUsd, estimatedCostUsd, projectBudget.hardCapUsd, projectBudget.softThresholdPct)
      if (!result.allow) {
        logger.warn(
          { projectId, runningCostUsd, estimatedCostUsd, hardCap: projectBudget.hardCapUsd },
          'CostEnforcer.canSpawn: project budget exceeded — blocking spawn',
        )
        await this._emitBudgetExceeded('project', projectId, runningCostUsd, projectBudget.hardCapUsd, uuidv7())
        return result
      }
      if (result.warn) {
        logger.warn(
          { projectId, runningCostUsd, hardCap: projectBudget.hardCapUsd },
          'CostEnforcer.canSpawn: project budget soft threshold crossed',
        )
      }
      return result
    }

    // No configured budget — allow freely.
    return {
      allow: true,
      action: 'allow',
      warn: false,
      runningCostUsd: 0,
      estimatedCostUsd,
      hardCapUsd: null,
    }
  }

  /**
   * Live check after a ledger entry is written.
   * If running cost exceeds hard cap and on_hard === 'kill', SIGTERM all workers.
   */
  async checkLive(projectId: string, sprintId?: string | null): Promise<void> {
    const scopeId = sprintId ?? projectId
    const scope   = sprintId ? 'sprint' : 'project'
    const budget  = await this.costService.getBudget(scope, scopeId)
    if (!budget || budget.onHard !== 'kill') return

    const runningCostUsd = await this.costService.getRunningCost(scope, scopeId)
    if (runningCostUsd <= budget.hardCapUsd) return

    logger.error(
      { scope, scopeId, runningCostUsd, hardCap: budget.hardCapUsd },
      'CostEnforcer.checkLive: hard cap exceeded with kill policy — SIGTERMing all workers',
    )

    const traceId = uuidv7()
    await this._killAllInScope(scope, scopeId, 'hard_cap_exceeded_live', traceId)
  }

  /**
   * Operator-initiated kill: SIGTERM all workers in the given scope.
   */
  async killAll(
    scope: 'install' | 'project' | 'sprint',
    scopeId: string,
    reason: string,
    actorId: string,
  ): Promise<{ killedWorkerIds: string[]; signalsSent: number }> {
    const traceId = uuidv7()
    return this._killAllInScope(scope, scopeId, reason, traceId, actorId)
  }

  // ---------------------------------------------------------------------------
  // Private
  // ---------------------------------------------------------------------------

  private _evaluate(
    runningCostUsd: number,
    estimatedCostUsd: number,
    hardCapUsd: number,
    softThresholdPct: number,
  ): EnforcerResult {
    const projected = runningCostUsd + estimatedCostUsd
    const softCap   = hardCapUsd * (softThresholdPct / 100)

    if (projected > hardCapUsd) {
      return {
        allow: false,
        action: 'pause',
        warn: true,
        reason: `Projected spend $${projected.toFixed(4)} exceeds hard cap $${hardCapUsd.toFixed(2)}`,
        runningCostUsd,
        estimatedCostUsd,
        hardCapUsd,
      }
    }

    if (projected > softCap) {
      return {
        allow: true,
        action: 'allow',
        warn: true,
        reason: `Projected spend $${projected.toFixed(4)} exceeds soft threshold`,
        runningCostUsd,
        estimatedCostUsd,
        hardCapUsd,
      }
    }

    return {
      allow: true,
      action: 'allow',
      warn: false,
      runningCostUsd,
      estimatedCostUsd,
      hardCapUsd,
    }
  }

  private async _emitBudgetExceeded(
    scope: string,
    scopeId: string,
    runningCostUsd: number,
    hardCapUsd: number,
    traceId: string,
  ): Promise<void> {
    const payload: BudgetExceededPayload = {
      scope,
      scope_id:         scopeId,
      running_cost_usd: runningCostUsd,
      hard_cap_usd:     hardCapUsd,
      occurred_at:      new Date().toISOString(),
    }
    try {
      await this.eventStore.append({
        aggregate_id:   scopeId,
        aggregate_type: 'sprint',
        event_type:     'BudgetExceeded',
        payload:        payload as unknown as Record<string, unknown>,
        actor:          SYSTEM_ACTOR,
        trace_id:       traceId,
        occurred_at:    payload.occurred_at,
        schema_version: 1,
      })
    } catch (err) {
      logger.warn({ err }, 'CostEnforcer._emitBudgetExceeded: event emit failed (non-fatal)')
    }
  }

  private async _killAllInScope(
    scope: string,
    scopeId: string,
    reason: string,
    traceId: string,
    actorId?: string,
  ): Promise<{ killedWorkerIds: string[]; signalsSent: number }> {
    // Find all non-terminated workers in scope.
    let workerRows: Array<{ worker_id: string; pid: number | null; status: string }>

    if (scope === 'sprint') {
      const raw = await this.db.execute<{ worker_id: string; pid: number | null; status: string }>(
        dSQL`
          SELECT aw.worker_id, aw.pid, aw.status
          FROM agent_workers aw
          LEFT JOIN tasks t ON t.task_id = aw.task_id
          WHERE t.sprint_id = ${scopeId}
            AND aw.status NOT IN ('terminated','terminating')
        `,
      )
      workerRows = raw as unknown as Array<{ worker_id: string; pid: number | null; status: string }>
    } else if (scope === 'project') {
      const raw = await this.db.execute<{ worker_id: string; pid: number | null; status: string }>(
        dSQL`
          SELECT aw.worker_id, aw.pid, aw.status
          FROM agent_workers aw
          LEFT JOIN tasks t ON t.task_id = aw.task_id
          WHERE t.sprint_id IN (
            SELECT sprint_id FROM sprints WHERE project_id = ${scopeId}
          )
            AND aw.status NOT IN ('terminated','terminating')
        `,
      )
      workerRows = raw as unknown as Array<{ worker_id: string; pid: number | null; status: string }>
    } else {
      // install scope — kill all active workers
      const raw = await this.db
        .select()
        .from(agentWorkers)
        .where(
          and(
            eq(agentWorkers.status, 'active'),
          ),
        )
      workerRows = raw.map((r) => ({
        worker_id: r.workerId,
        pid: r.pid,
        status: r.status,
      }))
    }

    const killedWorkerIds: string[] = []
    let signalsSent = 0

    for (const w of workerRows) {
      // Mark as terminating in DB.
      await this.db
        .update(agentWorkers)
        .set({ status: 'terminating' })
        .where(eq(agentWorkers.workerId, w.worker_id))
        .catch((err) => logger.warn({ err, workerId: w.worker_id }, 'CostEnforcer: update status failed'))

      // SIGTERM the process.
      if (w.pid != null) {
        try {
          this.killFn(w.pid, 'SIGTERM')
          signalsSent++
          logger.info(
            { workerId: w.worker_id, pid: w.pid, reason, scope, scopeId },
            'CostEnforcer._killAllInScope: SIGTERM sent',
          )
        } catch (err) {
          const code = (err as NodeJS.ErrnoException).code
          if (code !== 'ESRCH') {
            logger.warn({ err, workerId: w.worker_id, pid: w.pid }, 'CostEnforcer: SIGTERM failed')
          }
        }
      }

      killedWorkerIds.push(w.worker_id)

      // Emit KillSwitchTripped per worker.
      const payload: KillSwitchTrippedPayload = {
        worker_id:  w.worker_id,
        scope,
        scope_id:   scopeId,
        reason,
        actor_id:   actorId ?? 'system',
        killed_at:  new Date().toISOString(),
      }
      try {
        await this.eventStore.append({
          aggregate_id:   w.worker_id,
          aggregate_type: 'install',
          event_type:     'KillSwitchTripped',
          payload:        payload as unknown as Record<string, unknown>,
          actor:          SYSTEM_ACTOR,
          trace_id:       traceId,
          occurred_at:    payload.killed_at,
          schema_version: 1,
        })
      } catch (err) {
        logger.warn({ err, workerId: w.worker_id }, 'CostEnforcer: KillSwitchTripped emit failed')
      }
    }

    return { killedWorkerIds, signalsSent }
  }
}

// ---------------------------------------------------------------------------
// Singleton registry
// ---------------------------------------------------------------------------

let _costEnforcer: CostEnforcer | null = null

export function registerCostEnforcer(enforcer: CostEnforcer): void {
  _costEnforcer = enforcer
}

export function getCostEnforcer(): CostEnforcer {
  if (!_costEnforcer) {
    throw new Error('STARTUP_ERROR: CostEnforcer not registered. Call registerCostEnforcer() at boot.')
  }
  return _costEnforcer
}

export function createCostEnforcer(
  db: DB,
  eventStore: EventStore,
  costService: CostService,
  killFn?: (pid: number, signal: NodeJS.Signals) => void,
): CostEnforcer {
  return new CostEnforcer(db, eventStore, costService, killFn)
}
