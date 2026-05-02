/**
 * ceremony-scheduler.ts — Agent-native CeremonyScheduler.
 *
 * Per TRD-05 §6.2.6 (ceremony lifecycle).
 *
 * Responsibilities:
 *   - subscribe to EventStore via .subscribe(null, handler)
 *   - hold a registry of CeremonyTriggerRule instances
 *   - for each event:
 *       1. Check each rule whose `triggers` include the event_type
 *       2. Run rule.match(envelope, ctx) -> CeremonySpec | null
 *       3. If match AND no dedupe collision -> CeremonyService.schedule(spec)
 *       4. Emit CeremonyAutoScheduled with rule_id + trigger_event_id
 *
 * Dedupe: a single composite-PK row in `ceremony_trigger_firings` per
 * (rule_id, trigger_event_id). INSERT...ON CONFLICT DO NOTHING claims the
 * firing slot atomically; subsequent attempts (subscriber redelivery,
 * multi-process boot) are silent no-ops.
 *
 * Ceremonies fire on system state + events, never on a clock.
 */

import { uuidv7 } from 'uuidv7'
import { eq, sql as dSQL } from 'drizzle-orm'
import { OrbitalError, type EventEnvelope, type EventInput, type Actor } from '@orbital/types'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import type { CeremonyService, ScheduleCeremonyParams } from './ceremonies.js'
import { ceremonyTriggerFirings } from '../db/schema/ceremony-triggers.js'
import { logger } from '../config/logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Spec returned by a CeremonyTriggerRule.match — the inputs a rule provides to
 * `CeremonyService.schedule`, plus optional invitation hints recorded in the
 * scope for the UI / future participant-spawn step.
 */
export type CeremonySpec = ScheduleCeremonyParams & {
  /**
   * Persona roles to invite. Recorded as part of `scope.invited_roles` so the
   * UI sibling agent can render the invitation list. Participant rows are NOT
   * created here — that happens during ceremony.start when the chair
   * persona invites the actors. Keeping this advisory keeps the scheduler
   * stateless w.r.t. participant identity.
   */
  invitedRoles?: string[]
}

/**
 * Context passed to every rule.match call.
 *
 * - `db` for state-of-the-world SQL queries (cheaper than event-log scans for
 *   "current backlog count" style checks).
 * - `eventStore` for cross-event correlation (rare; most rules use db).
 * - `ceremonyService` is included for completeness; rules return a spec rather
 *   than calling `schedule` directly so dedupe/idempotency stays centralized.
 * - `alreadyFired(ruleId, triggerEventId)` is provided as an explicit hook for
 *   rules that want to short-circuit before doing expensive state queries; the
 *   scheduler always re-checks via the dedupe insert before scheduling.
 */
export interface TriggerContext {
  db: DB
  eventStore: EventStore
  ceremonyService: CeremonyService
  alreadyFired(ruleId: string, triggerEventId: string): Promise<boolean>
}

/**
 * A trigger rule: cheap pre-filter via `triggers`, then a state-aware
 * `match()` that returns a CeremonySpec or null.
 *
 * Implementations live in `comms/ceremony-triggers/*.ts`, one per rule.
 */
export interface CeremonyTriggerRule {
  id: string
  description: string
  triggers: string[]
  match(envelope: EventEnvelope, ctx: TriggerContext): Promise<CeremonySpec | null>
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'ceremony_scheduler' }

export interface CeremonySchedulerOptions {
  /** Skip wiring (returns a no-op start/stop). */
  disabled?: boolean
  /**
   * Hook invoked after a successful auto-schedule. Tests use this to await the
   * effect of a synthetic event without polling.
   */
  onCeremonyAutoScheduled?: (info: {
    ceremonyId: string
    ruleId: string
    triggerEventId: string
    ceremonyType: string
  }) => void
}

export interface CeremonySchedulerDeps {
  db: DB
  eventStore: EventStore
  ceremonyService: CeremonyService
  ruleRegistry: CeremonyTriggerRule[]
  options?: CeremonySchedulerOptions
}

export interface CeremonyScheduler {
  start(): void
  stop(): void
  /** Direct entry point — bypass subscribe; tests drive events through here. */
  onEvent(envelope: EventEnvelope): Promise<void>
  /** List of registered rule ids; useful for diagnostics + tests. */
  registeredRuleIds(): string[]
}

export class DefaultCeremonyScheduler implements CeremonyScheduler {
  private readonly db: DB
  private readonly eventStore: EventStore
  private readonly ceremonyService: CeremonyService
  private readonly rules: CeremonyTriggerRule[]
  private readonly options: CeremonySchedulerOptions
  private unsubscribe: (() => void) | null = null
  /** Map from event_type -> matching rules; built once at construction. */
  private readonly rulesByEventType: Map<string, CeremonyTriggerRule[]>

  constructor(deps: CeremonySchedulerDeps) {
    this.db = deps.db
    this.eventStore = deps.eventStore
    this.ceremonyService = deps.ceremonyService
    this.rules = deps.ruleRegistry
    this.options = deps.options ?? {}

    // Pre-index by event_type for cheap dispatch.
    const idx = new Map<string, CeremonyTriggerRule[]>()
    for (const rule of this.rules) {
      for (const trigger of rule.triggers) {
        const list = idx.get(trigger) ?? []
        list.push(rule)
        idx.set(trigger, list)
      }
    }
    this.rulesByEventType = idx
  }

  // -------------------------------------------------------------------------
  // start / stop
  // -------------------------------------------------------------------------

  start(): void {
    if (this.options.disabled === true) {
      logger.info('CeremonyScheduler: disabled via options; not subscribing')
      return
    }
    if (this.unsubscribe !== null) return
    this.unsubscribe = this.eventStore.subscribe(null, (envelope) => {
      // Fire-and-forget; errors are logged. Rule failures must not block the
      // event subscriber thread.
      void this.onEvent(envelope).catch((err: unknown) => {
        logger.error(
          { err, eventId: envelope.event_id, eventType: envelope.event_type },
          'CeremonyScheduler.onEvent: handler failed',
        )
      })
    })
    logger.info(
      { ruleCount: this.rules.length, eventTypes: [...this.rulesByEventType.keys()] },
      'CeremonyScheduler: started',
    )
  }

  stop(): void {
    if (this.unsubscribe === null) return
    this.unsubscribe()
    this.unsubscribe = null
  }

  // -------------------------------------------------------------------------
  // registeredRuleIds
  // -------------------------------------------------------------------------

  registeredRuleIds(): string[] {
    return this.rules.map((r) => r.id)
  }

  // -------------------------------------------------------------------------
  // onEvent — main dispatch
  // -------------------------------------------------------------------------

  async onEvent(envelope: EventEnvelope): Promise<void> {
    const matching = this.rulesByEventType.get(envelope.event_type)
    if (!matching || matching.length === 0) return

    const ctx: TriggerContext = {
      db: this.db,
      eventStore: this.eventStore,
      ceremonyService: this.ceremonyService,
      alreadyFired: (ruleId, triggerEventId) => this.alreadyFired(ruleId, triggerEventId),
    }

    for (const rule of matching) {
      try {
        // Cheap dedupe pre-check; the dedupe-insert-on-success below is the
        // authoritative gate, but this avoids running a state query when we
        // have already fired.
        if (await this.alreadyFired(rule.id, envelope.event_id)) continue

        const spec = await rule.match(envelope, ctx)
        if (spec === null) continue

        await this.fireRule(rule, envelope, spec)
      } catch (err) {
        logger.error(
          {
            err,
            ruleId: rule.id,
            eventId: envelope.event_id,
            eventType: envelope.event_type,
          },
          'CeremonyScheduler: rule failed',
        )
        // Continue to next rule — one bad rule must not block others.
      }
    }
  }

  // -------------------------------------------------------------------------
  // fireRule — dedupe insert -> CeremonyService.schedule -> emit audit event
  // -------------------------------------------------------------------------

  private async fireRule(
    rule: CeremonyTriggerRule,
    envelope: EventEnvelope,
    spec: CeremonySpec,
  ): Promise<void> {
    // Atomically claim the (ruleId, triggerEventId) slot. ON CONFLICT DO
    // NOTHING returns 0 rows when another instance already claimed it.
    const claimed = await this.db.execute<{ rule_id: string; trigger_event_id: string }>(dSQL`
      INSERT INTO ceremony_trigger_firings (rule_id, trigger_event_id)
      VALUES (${rule.id}, ${envelope.event_id})
      ON CONFLICT (rule_id, trigger_event_id) DO NOTHING
      RETURNING rule_id, trigger_event_id
    `)
    const claimedRows = claimed as unknown as Array<{
      rule_id: string
      trigger_event_id: string
    }>
    if (claimedRows.length === 0) {
      // Lost the race; another scheduler/handler already claimed this firing.
      return
    }

    // Build the schedule params, recording rule provenance into scope.
    const scopedScope = {
      ...spec.scope,
      auto_scheduled: true,
      rule_id: rule.id,
      trigger_event_id: envelope.event_id,
      trigger_event_type: envelope.event_type,
      ...(spec.invitedRoles ? { invited_roles: spec.invitedRoles } : {}),
    }

    const scheduleParams: ScheduleCeremonyParams = {
      ceremonyType: spec.ceremonyType,
      scope: scopedScope,
      triggeredBy: spec.triggeredBy ?? SYSTEM_ACTOR,
      ...(spec.specId !== undefined ? { specId: spec.specId } : {}),
      ...(spec.turnsPerParticipant !== undefined
        ? { turnsPerParticipant: spec.turnsPerParticipant }
        : {}),
      ...(spec.tokensPerTurn !== undefined ? { tokensPerTurn: spec.tokensPerTurn } : {}),
      ...(spec.wallClockBudgetMs !== undefined
        ? { wallClockBudgetMs: spec.wallClockBudgetMs }
        : {}),
    }

    let ceremonyId: string
    try {
      const result = await this.ceremonyService.schedule(scheduleParams)
      ceremonyId = result.ceremonyId
    } catch (err) {
      // Mark the firing as failed by leaving ceremonyId NULL. We don't delete
      // the row — that would let the same event re-fire on retry, which is
      // exactly what dedupe is supposed to prevent. Operators can inspect
      // firings with NULL ceremonyId to see failed auto-schedules.
      logger.error(
        { err, ruleId: rule.id, eventId: envelope.event_id, ceremonyType: spec.ceremonyType },
        'CeremonyScheduler.fireRule: CeremonyService.schedule failed',
      )
      throw err instanceof OrbitalError
        ? err
        : new OrbitalError('INTERNAL_DB_ERROR', `auto-schedule failed for rule ${rule.id}`)
    }

    // Update the firing row with the resulting ceremonyId.
    await this.db
      .update(ceremonyTriggerFirings)
      .set({ ceremonyId })
      .where(eq(ceremonyTriggerFirings.ruleId, rule.id))

    // Emit the CeremonyAutoScheduled audit event.
    const auditEvent: EventInput = {
      aggregate_id: ceremonyId,
      aggregate_type: 'ceremony',
      event_type: 'CeremonyAutoScheduled',
      payload: {
        ceremony_id: ceremonyId,
        ceremony_type: spec.ceremonyType,
        rule_id: rule.id,
        rule_description: rule.description,
        trigger_event_id: envelope.event_id,
        trigger_event_type: envelope.event_type,
        invited_roles: spec.invitedRoles ?? [],
      },
      actor: SYSTEM_ACTOR,
      trace_id: envelope.trace_id,
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(auditEvent)

    logger.info(
      {
        ruleId: rule.id,
        ceremonyId,
        ceremonyType: spec.ceremonyType,
        triggerEventId: envelope.event_id,
        triggerEventType: envelope.event_type,
      },
      'CeremonyScheduler: ceremony auto-scheduled',
    )

    if (this.options.onCeremonyAutoScheduled) {
      this.options.onCeremonyAutoScheduled({
        ceremonyId,
        ruleId: rule.id,
        triggerEventId: envelope.event_id,
        ceremonyType: spec.ceremonyType,
      })
    }
  }

  // -------------------------------------------------------------------------
  // alreadyFired
  // -------------------------------------------------------------------------

  private async alreadyFired(ruleId: string, triggerEventId: string): Promise<boolean> {
    const rows = await this.db.execute<{ exists: boolean }>(dSQL`
      SELECT 1 AS exists
      FROM ceremony_trigger_firings
      WHERE rule_id = ${ruleId}
        AND trigger_event_id = ${triggerEventId}
      LIMIT 1
    `)
    const arr = rows as unknown as Array<unknown>
    return arr.length > 0
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createCeremonyScheduler(deps: CeremonySchedulerDeps): CeremonyScheduler {
  return new DefaultCeremonyScheduler(deps)
}
