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
import { eq, sql as dSQL } from 'drizzle-orm';
import { OrbitalError } from '@orbital/types';
import { ceremonyTriggerFirings } from '@orbital/db';
import { logger } from '../logger.js';
// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------
const SYSTEM_ACTOR = { type: 'system', component: 'ceremony_scheduler' };
export class DefaultCeremonyScheduler {
    db;
    eventStore;
    ceremonyService;
    rules;
    options;
    unsubscribe = null;
    /** Map from event_type -> matching rules; built once at construction. */
    rulesByEventType;
    constructor(deps) {
        this.db = deps.db;
        this.eventStore = deps.eventStore;
        this.ceremonyService = deps.ceremonyService;
        this.rules = deps.ruleRegistry;
        this.options = deps.options ?? {};
        // Pre-index by event_type for cheap dispatch.
        const idx = new Map();
        for (const rule of this.rules) {
            for (const trigger of rule.triggers) {
                const list = idx.get(trigger) ?? [];
                list.push(rule);
                idx.set(trigger, list);
            }
        }
        this.rulesByEventType = idx;
    }
    // -------------------------------------------------------------------------
    // start / stop
    // -------------------------------------------------------------------------
    start() {
        if (this.options.disabled === true) {
            logger.info('CeremonyScheduler: disabled via options; not subscribing');
            return;
        }
        if (this.unsubscribe !== null)
            return;
        this.unsubscribe = this.eventStore.subscribe(null, (envelope) => {
            // Fire-and-forget; errors are logged. Rule failures must not block the
            // event subscriber thread.
            void this.onEvent(envelope).catch((err) => {
                logger.error({ err, eventId: envelope.event_id, eventType: envelope.event_type }, 'CeremonyScheduler.onEvent: handler failed');
            });
        });
        logger.info({ ruleCount: this.rules.length, eventTypes: [...this.rulesByEventType.keys()] }, 'CeremonyScheduler: started');
    }
    stop() {
        if (this.unsubscribe === null)
            return;
        this.unsubscribe();
        this.unsubscribe = null;
    }
    // -------------------------------------------------------------------------
    // registeredRuleIds
    // -------------------------------------------------------------------------
    registeredRuleIds() {
        return this.rules.map((r) => r.id);
    }
    // -------------------------------------------------------------------------
    // onEvent — main dispatch
    // -------------------------------------------------------------------------
    async onEvent(envelope) {
        const matching = this.rulesByEventType.get(envelope.event_type);
        if (!matching || matching.length === 0)
            return;
        const ctx = {
            db: this.db,
            eventStore: this.eventStore,
            ceremonyService: this.ceremonyService,
            alreadyFired: (ruleId, triggerEventId) => this.alreadyFired(ruleId, triggerEventId),
        };
        for (const rule of matching) {
            try {
                // Cheap dedupe pre-check; the dedupe-insert-on-success below is the
                // authoritative gate, but this avoids running a state query when we
                // have already fired.
                if (await this.alreadyFired(rule.id, envelope.event_id))
                    continue;
                const spec = await rule.match(envelope, ctx);
                if (spec === null)
                    continue;
                await this.fireRule(rule, envelope, spec);
            }
            catch (err) {
                logger.error({
                    err,
                    ruleId: rule.id,
                    eventId: envelope.event_id,
                    eventType: envelope.event_type,
                }, 'CeremonyScheduler: rule failed');
                // Continue to next rule — one bad rule must not block others.
            }
        }
    }
    // -------------------------------------------------------------------------
    // fireRule — dedupe insert -> CeremonyService.schedule -> emit audit event
    // -------------------------------------------------------------------------
    async fireRule(rule, envelope, spec) {
        // Atomically claim the (ruleId, triggerEventId) slot. ON CONFLICT DO
        // NOTHING returns 0 rows when another instance already claimed it.
        const claimed = await this.db.execute(dSQL `
      INSERT INTO ceremony_trigger_firings (rule_id, trigger_event_id)
      VALUES (${rule.id}, ${envelope.event_id})
      ON CONFLICT (rule_id, trigger_event_id) DO NOTHING
      RETURNING rule_id, trigger_event_id
    `);
        const claimedRows = claimed;
        if (claimedRows.length === 0) {
            // Lost the race; another scheduler/handler already claimed this firing.
            return;
        }
        // Build the schedule params, recording rule provenance into scope.
        const scopedScope = {
            ...spec.scope,
            auto_scheduled: true,
            rule_id: rule.id,
            trigger_event_id: envelope.event_id,
            trigger_event_type: envelope.event_type,
            ...(spec.invitedRoles ? { invited_roles: spec.invitedRoles } : {}),
        };
        const scheduleParams = {
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
        };
        let ceremonyId;
        try {
            const result = await this.ceremonyService.schedule(scheduleParams);
            ceremonyId = result.ceremonyId;
        }
        catch (err) {
            // Mark the firing as failed by leaving ceremonyId NULL. We don't delete
            // the row — that would let the same event re-fire on retry, which is
            // exactly what dedupe is supposed to prevent. Operators can inspect
            // firings with NULL ceremonyId to see failed auto-schedules.
            logger.error({ err, ruleId: rule.id, eventId: envelope.event_id, ceremonyType: spec.ceremonyType }, 'CeremonyScheduler.fireRule: CeremonyService.schedule failed');
            throw err instanceof OrbitalError
                ? err
                : new OrbitalError('INTERNAL_DB_ERROR', `auto-schedule failed for rule ${rule.id}`);
        }
        // Update the firing row with the resulting ceremonyId.
        await this.db
            .update(ceremonyTriggerFirings)
            .set({ ceremonyId })
            .where(eq(ceremonyTriggerFirings.ruleId, rule.id));
        // Emit the CeremonyAutoScheduled audit event.
        const auditEvent = {
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
        };
        await this.eventStore.append(auditEvent);
        logger.info({
            ruleId: rule.id,
            ceremonyId,
            ceremonyType: spec.ceremonyType,
            triggerEventId: envelope.event_id,
            triggerEventType: envelope.event_type,
        }, 'CeremonyScheduler: ceremony auto-scheduled');
        if (this.options.onCeremonyAutoScheduled) {
            this.options.onCeremonyAutoScheduled({
                ceremonyId,
                ruleId: rule.id,
                triggerEventId: envelope.event_id,
                ceremonyType: spec.ceremonyType,
            });
        }
    }
    // -------------------------------------------------------------------------
    // alreadyFired
    // -------------------------------------------------------------------------
    async alreadyFired(ruleId, triggerEventId) {
        const rows = await this.db.execute(dSQL `
      SELECT 1 AS exists
      FROM ceremony_trigger_firings
      WHERE rule_id = ${ruleId}
        AND trigger_event_id = ${triggerEventId}
      LIMIT 1
    `);
        const arr = rows;
        return arr.length > 0;
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createCeremonyScheduler(deps) {
    return new DefaultCeremonyScheduler(deps);
}
//# sourceMappingURL=ceremony-scheduler.js.map