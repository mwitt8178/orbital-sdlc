/**
 * CostAccounting — per-turn cost calculation and budget enforcement.
 *
 * Per TRD-08 §4.2 (cost_accounting table), §7.3 (cost.report MCP tool),
 * §8.2–8.4 (events), §9 (budget enforcement).
 *
 * Rate table per task spec (per-million tokens, in USD micros):
 *   opus:   $15 in / $75 out / cache_read 10% of input / cache_write 1.25x input
 *   sonnet: $3 in  / $15 out / cache_read 10% of input / cache_write 1.25x input
 *   haiku:  $0.80 in / $4 out / cache_read 10% of input / cache_write 1.25x input
 *
 * Cost events written via EventStore, never direct db.insert(events).
 */
import { uuidv7 } from 'uuidv7';
import { eq, and, sum } from 'drizzle-orm';
import { costAccounting, budgetCaps } from '../db/schema/routing.js';
import { logger } from '../config/logger.js';
const MODEL_RATES = {
    'claude-opus-4-6': {
        input: 15_000_000, // $15/Mtok
        output: 75_000_000, // $75/Mtok
        cacheRead: 1_500_000, // 10% of $15 = $1.50/Mtok
        cacheWrite: 18_750_000, // 1.25x $15 = $18.75/Mtok
    },
    'claude-sonnet-4-6': {
        input: 3_000_000, // $3/Mtok
        output: 15_000_000, // $15/Mtok
        cacheRead: 300_000, // 10% of $3 = $0.30/Mtok
        cacheWrite: 3_750_000, // 1.25x $3 = $3.75/Mtok
    },
    'claude-haiku-4-5': {
        input: 800_000, // $0.80/Mtok
        output: 4_000_000, // $4/Mtok
        cacheRead: 80_000, // 10% of $0.80 = $0.08/Mtok
        cacheWrite: 1_000_000, // 1.25x $0.80 = $1.00/Mtok
    },
};
/**
 * Compute cost in USD micros for a usage record.
 * Pure function; no I/O.
 */
export function computeCostMicros(model, usage) {
    const rates = MODEL_RATES[model];
    if (!rates) {
        logger.warn({ model }, 'computeCostMicros: unknown model; using sonnet rates');
        return computeCostMicros('claude-sonnet-4-6', usage);
    }
    const M = 1_000_000;
    const cost = (usage.input_tokens / M) * rates.input +
        (usage.output_tokens / M) * rates.output +
        (usage.cache_read_input_tokens / M) * rates.cacheRead +
        (usage.cache_creation_input_tokens / M) * rates.cacheWrite;
    return Math.round(cost);
}
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
const SYSTEM_ACTOR = { type: 'system', component: 'orchestrator' };
export class PostgresCostAccounting {
    db;
    eventStore;
    constructor(db, eventStore) {
        this.db = db;
        this.eventStore = eventStore;
    }
    async report(params) {
        const { taskId, sessionId, sprintId, ticketId, model, turnIndex, usage, traceId, reportedAt = new Date().toISOString(), } = params;
        // Idempotency: check if this turn was already reported
        const existing = await this.db
            .select()
            .from(costAccounting)
            .where(and(eq(costAccounting.sessionId, sessionId), eq(costAccounting.turnIndex, turnIndex)))
            .limit(1);
        if (existing[0]) {
            // Return original row without double-counting
            const totalRows = await this.db
                .select({ total: sum(costAccounting.costUsdMicros) })
                .from(costAccounting)
                .where(eq(costAccounting.sessionId, sessionId));
            const cumulative = Number(totalRows[0]?.total ?? 0);
            return {
                costId: existing[0].costId,
                costUsdMicros: existing[0].costUsdMicros,
                cumulativeSessionUsdMicros: cumulative,
                budgetState: 'ok',
            };
        }
        const validatedUsage = {
            input_tokens: usage.input_tokens,
            output_tokens: usage.output_tokens,
            cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
            cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
        };
        const costUsdMicros = computeCostMicros(model, validatedUsage);
        const costId = uuidv7();
        // Insert cost row
        await this.db.insert(costAccounting).values({
            costId,
            taskId,
            sessionId,
            sprintId,
            ticketId,
            model,
            inputTokens: validatedUsage.input_tokens,
            outputTokens: validatedUsage.output_tokens,
            cacheReadTokens: validatedUsage.cache_read_input_tokens,
            cacheWriteTokens: validatedUsage.cache_creation_input_tokens,
            costUsdMicros,
            turnIndex,
            reportedAt,
            traceId,
        });
        // Compute cumulative session cost
        const totalRows = await this.db
            .select({ total: sum(costAccounting.costUsdMicros) })
            .from(costAccounting)
            .where(eq(costAccounting.sessionId, sessionId));
        const cumulativeSessionUsdMicros = Number(totalRows[0]?.total ?? costUsdMicros);
        // Emit CostReported event
        await this.eventStore.append({
            aggregate_id: taskId,
            aggregate_type: 'task',
            event_type: 'CostReported',
            payload: {
                cost_id: costId,
                task_id: taskId,
                session_id: sessionId,
                sprint_id: sprintId,
                ticket_id: ticketId,
                model,
                turn_index: turnIndex,
                input_tokens: validatedUsage.input_tokens,
                output_tokens: validatedUsage.output_tokens,
                cache_read_tokens: validatedUsage.cache_read_input_tokens,
                cache_write_tokens: validatedUsage.cache_creation_input_tokens,
                cost_usd_micros: costUsdMicros,
                cumulative_session_usd_micros: cumulativeSessionUsdMicros,
            },
            actor: SYSTEM_ACTOR,
            trace_id: traceId,
            occurred_at: reportedAt,
            schema_version: 1,
        });
        // Check budget caps
        const budgetState = await this.checkAndUpdateBudgetCaps(taskId, sprintId, costUsdMicros, costId, sessionId, traceId);
        return {
            costId,
            costUsdMicros,
            cumulativeSessionUsdMicros,
            budgetState,
        };
    }
    async getSprintTotal(sprintId) {
        const rows = await this.db
            .select()
            .from(costAccounting)
            .where(eq(costAccounting.sprintId, sprintId));
        return aggregateCostRows(rows);
    }
    async getTaskTotal(taskId) {
        const rows = await this.db
            .select()
            .from(costAccounting)
            .where(eq(costAccounting.taskId, taskId));
        return aggregateCostRows(rows);
    }
    // --------------------------------------------------------------------------
    // Private: budget cap enforcement
    // --------------------------------------------------------------------------
    async checkAndUpdateBudgetCaps(taskId, sprintId, newCostMicros, triggeringCostId, triggeringSessionId, traceId) {
        // Check sprint cap
        const sprintCapRows = await this.db
            .select()
            .from(budgetCaps)
            .where(and(eq(budgetCaps.scope, 'sprint'), eq(budgetCaps.scopeKey, sprintId)))
            .limit(1);
        const sprintCap = sprintCapRows[0];
        if (sprintCap && sprintCap.state !== 'overridden') {
            const sprintTotal = await this.getSprintTotal(sprintId);
            const consumed = sprintTotal.total_usd_micros;
            const pct = (consumed / sprintCap.capUsdMicros) * 100;
            const capId = sprintCap.capId;
            const now = new Date().toISOString();
            if (pct >= 100 && sprintCap.state !== 'exceeded') {
                await this.db
                    .update(budgetCaps)
                    .set({ state: 'exceeded', updatedAt: now })
                    .where(eq(budgetCaps.capId, capId));
                await this.emitBudgetExceeded(capId, 'sprint', sprintId, sprintCap.capUsdMicros, consumed, triggeringCostId, triggeringSessionId, traceId);
                return 'exceeded';
            }
            if (pct >= sprintCap.warningThresholdPct && sprintCap.state === 'active') {
                await this.db
                    .update(budgetCaps)
                    .set({ state: 'warned', updatedAt: now })
                    .where(eq(budgetCaps.capId, capId));
                await this.emitBudgetWarning(capId, 'sprint', sprintId, sprintCap.capUsdMicros, consumed, pct, sprintCap.warningThresholdPct, traceId);
                return 'warned';
            }
            if (sprintCap.state === 'exceeded')
                return 'exceeded';
            if (sprintCap.state === 'warned')
                return 'warned';
        }
        return 'ok';
    }
    async emitBudgetWarning(capId, scope, scopeKey, capUsdMicros, consumedUsdMicros, pctConsumed, thresholdPct, traceId) {
        await this.eventStore.append({
            aggregate_id: scopeKey,
            aggregate_type: 'sprint',
            event_type: 'BudgetWarning',
            payload: {
                cap_id: capId,
                scope,
                scope_key: scopeKey,
                cap_usd_micros: capUsdMicros,
                consumed_usd_micros: consumedUsdMicros,
                pct_consumed: Math.round(pctConsumed),
                threshold_pct: thresholdPct,
            },
            actor: SYSTEM_ACTOR,
            trace_id: traceId,
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        });
    }
    async emitBudgetExceeded(capId, scope, scopeKey, capUsdMicros, consumedUsdMicros, triggeringCostId, triggeringSessionId, traceId) {
        await this.eventStore.append({
            aggregate_id: scopeKey,
            aggregate_type: 'sprint',
            event_type: 'BudgetExceeded',
            payload: {
                cap_id: capId,
                scope,
                scope_key: scopeKey,
                cap_usd_micros: capUsdMicros,
                consumed_usd_micros: consumedUsdMicros,
                triggering_cost_id: triggeringCostId,
                triggering_session_id: triggeringSessionId,
                halt_action: scope === 'sprint' ? 'suspend_sprint' : 'stop_new_spawns',
            },
            actor: SYSTEM_ACTOR,
            trace_id: traceId,
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        });
    }
}
// ---------------------------------------------------------------------------
// Aggregate helpers
// ---------------------------------------------------------------------------
function aggregateCostRows(rows) {
    return rows.reduce((acc, row) => ({
        total_usd_micros: acc.total_usd_micros + row.costUsdMicros,
        input_tokens: acc.input_tokens + row.inputTokens,
        output_tokens: acc.output_tokens + row.outputTokens,
        cache_read_tokens: acc.cache_read_tokens + row.cacheReadTokens,
        cache_write_tokens: acc.cache_write_tokens + row.cacheWriteTokens,
        turn_count: acc.turn_count + 1,
    }), {
        total_usd_micros: 0,
        input_tokens: 0,
        output_tokens: 0,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        turn_count: 0,
    });
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createCostAccounting(db, eventStore) {
    return new PostgresCostAccounting(db, eventStore);
}
//# sourceMappingURL=cost.js.map