/**
 * instrumentation.ts — Hooks that feed Prometheus metrics from live system state.
 *
 * Per Phase 6B spec:
 * 1. Subscribes to EventStore: every appended event increments orbital_events_total{event_type}
 *    and specifically increments orbital_capability_denials_total on CapabilityDenied.
 * 2. Syncs orbital_active_workers from agent_workers DB table every 10s.
 * 3. Syncs orbital_budget_utilization from routing / cost data every 10s.
 *    (budget_utilization is computed from tasks tokens_consumed / token_budget per sprint)
 *
 * IMPORTANT: EventStore is wrapped, NOT modified. We subscribe via EventStore.subscribe()
 * and wrap EventStore.append via a wrapAppend helper that injects the active OTel trace_id.
 *
 * Exports:
 *   `startMetricsInstrumentation({ eventStore, db }): () => void`  — starts all hooks,
 *   returns a stop function that cleans up subscriptions and timers.
 */

import { eq, inArray, sql as dSQL } from 'drizzle-orm'
import { trace } from '@opentelemetry/api'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import type { EventEnvelope, EventInput } from '../events/types.js'
import { agentWorkers } from '../db/schema/worker-tables.js'
import { tasks } from '../db/schema/orchestration.js'
import { logger } from '../config/logger.js'
import {
  incEventsTotal,
  incCapabilityDenials,
  setActiveWorkers,
  setBudgetUtilization,
} from './prometheus.js'

const SYNC_INTERVAL_MS = 10_000

export interface InstrumentationDeps {
  eventStore: EventStore
  db: DB
}

// ---------------------------------------------------------------------------
// wrapAppend — wraps EventStore.append to inject the active OTel trace_id
// when one is available from the active span context.
//
// The original EventStore.append is NOT modified. This wrapper is applied
// once at startup and the wrapped store is what services use.
// ---------------------------------------------------------------------------

export function wrapAppend(store: EventStore): EventStore {
  const original = store.append.bind(store)

  const wrapped: EventStore['append'] = async (event: EventInput): Promise<EventEnvelope> => {
    // Resolve trace_id from active OTel span if present; otherwise keep caller-provided value.
    const activeSpan = trace.getActiveSpan()
    const spanTraceId = activeSpan?.spanContext().traceId
    const NOOP_TRACE_ID = '00000000000000000000000000000000'

    const enriched: EventInput = {
      ...event,
      trace_id:
        spanTraceId && spanTraceId !== NOOP_TRACE_ID ? spanTraceId : event.trace_id,
    }

    return original(enriched)
  }

  // Return a wrapper object that delegates everything to the original store
  // but overrides append. We cannot use object spread on class instances because
  // class methods live on the prototype and are not own-properties.
  return {
    append: wrapped,
    query: store.query.bind(store),
    subscribe: store.subscribe.bind(store),
  }
}

// ---------------------------------------------------------------------------
// startMetricsInstrumentation
// ---------------------------------------------------------------------------

export function startMetricsInstrumentation({ eventStore, db }: InstrumentationDeps): () => void {
  // 1. Subscribe to EventStore for event-level counters.
  //    subscribe() returns an unsubscribe function.
  const unsubscribe = eventStore.subscribe(null, (event: EventEnvelope) => {
    incEventsTotal(event.event_type)

    if (event.event_type === 'CapabilityDenied') {
      incCapabilityDenials()
    }
  })

  // 2. Periodic sync: active workers + budget utilization.
  const syncTimer = setInterval(() => {
    void syncGauges(db).catch((err: unknown) => {
      logger.warn({ err }, 'metrics instrumentation: gauge sync failed')
    })
  }, SYNC_INTERVAL_MS)

  // Run an initial sync immediately so gauges are populated at startup.
  void syncGauges(db).catch((err: unknown) => {
    logger.warn({ err }, 'metrics instrumentation: initial gauge sync failed')
  })

  return () => {
    unsubscribe()
    clearInterval(syncTimer)
  }
}

// ---------------------------------------------------------------------------
// syncGauges — reads from DB and updates Prometheus gauges
// ---------------------------------------------------------------------------

async function syncGauges(db: DB): Promise<void> {
  await Promise.all([syncActiveWorkers(db), syncBudgetUtilization(db)])
}

async function syncActiveWorkers(db: DB): Promise<void> {
  try {
    const result = await db
      .select({ count: dSQL<number>`count(*)::int` })
      .from(agentWorkers)
      .where(eq(agentWorkers.status, 'active'))

    const count = result[0]?.count ?? 0
    setActiveWorkers(count)
  } catch (err) {
    logger.debug({ err }, 'metrics: syncActiveWorkers query failed')
  }
}

async function syncBudgetUtilization(db: DB): Promise<void> {
  try {
    // Aggregate token utilization per sprint: sum(tokens_consumed) / sum(token_budget)
    // Only active sprints (tasks in non-terminal states).
    const rows = await db
      .select({
        sprintId: tasks.sprintId,
        tokensConsumed: dSQL<number>`sum(tokens_consumed)::bigint`,
        tokenBudget: dSQL<number>`sum(token_budget)::bigint`,
      })
      .from(tasks)
      .where(
        inArray(tasks.state, ['pending', 'ready', 'in_progress', 'in_review', 'blocked']),
      )
      .groupBy(tasks.sprintId)

    for (const row of rows) {
      const budget = row.tokenBudget ?? 0
      const consumed = row.tokensConsumed ?? 0
      if (budget > 0) {
        setBudgetUtilization(row.sprintId, consumed / budget)
      }
    }
  } catch (err) {
    logger.debug({ err }, 'metrics: syncBudgetUtilization query failed')
  }
}
