/**
 * lambda/scheduled/sprint-planning.ts — EventBridge-triggered sprint planning ceremony.
 *
 * [Engineer-Sr · Sonnet · run-round8-05-event-bus]
 *
 * Fires every day at 9am UTC (EventBridge cron rule).
 *
 * Per-tenant timezone check:
 *  - Reads the `tenants` table for all active tenants.
 *  - For each tenant, checks if their local time is within the ceremony window
 *    (08:45–09:15 local time, allowing for schedule drift).
 *  - If yes: kicks off the sprint-planning ceremony for that tenant.
 *  - If no: skips (they'll get it when the 9am UTC rule next fires near their local 9am).
 *
 * Since EventBridge fires hourly (the sprint-planning rule fires at 9am UTC, but
 * tenant timezones vary), the Lambda runs on every scheduled invocation and uses
 * the per-tenant timezone to decide who is "at their 9am" right now.
 *
 * v1: structured log per tenant indicating ceremony status.
 * v2 (deferred): kick off the actual sprint-planning tRPC handler.
 */

import { logger } from '../../config/logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface EventBridgeScheduledEvent {
  version: string
  id: string
  'detail-type': string
  source: string
  account: string
  time: string
  region: string
  detail: Record<string, unknown>
}

/** Tenant row from DB (minimal shape for this Lambda). */
interface TenantRow {
  tenant_id: string
  name: string
  timezone: string
  active: boolean
}

// ---------------------------------------------------------------------------
// Per-tenant timezone check
// ---------------------------------------------------------------------------

/**
 * Check if the current UTC time falls within the ceremony window for a given
 * tenant timezone.
 *
 * Window: 08:45–09:15 local time (30-minute window centered on 9am).
 * This tolerates EventBridge schedule drift and tenants who set non-standard
 * ceremony times via config.
 */
export function isWithinSprintPlanningWindow(
  utcNow: Date,
  tenantTimezone: string,
): boolean {
  try {
    // Get the local time for this tenant
    const localTimeStr = utcNow.toLocaleString('en-US', {
      timeZone: tenantTimezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    })

    // Parse HH:MM
    const [hourStr, minuteStr] = localTimeStr.split(':')
    const hour = parseInt(hourStr ?? '0', 10)
    const minute = parseInt(minuteStr ?? '0', 10)
    const localMinutes = hour * 60 + minute

    // Window: 08:45 (525 min) to 09:15 (555 min)
    const windowStart = 8 * 60 + 45 // 525
    const windowEnd = 9 * 60 + 15   // 555

    return localMinutes >= windowStart && localMinutes <= windowEnd
  } catch (err) {
    logger.warn(
      { tenantTimezone, err },
      'sprint-planning: failed to parse tenant timezone — defaulting to skip',
    )
    return false
  }
}

// ---------------------------------------------------------------------------
// Tenant loader (v1: returns static placeholder; v2: reads from DB)
// ---------------------------------------------------------------------------

/**
 * Load active tenants.
 *
 * v1: returns empty array (no DB connection in this Lambda; v2 wires RDS Proxy).
 * v2 (deferred): SELECT tenant_id, name, timezone FROM tenants WHERE active = true
 */
async function loadActiveTenants(): Promise<TenantRow[]> {
  // v2 TODO (deferred): query Aurora via RDS Proxy
  // const db = await getDb()
  // return db.select().from(tenants).where(eq(tenants.active, true))
  logger.debug('sprint-planning: v1 stub — no tenants loaded from DB (deferred)')
  return []
}

/**
 * Kick off sprint planning for a tenant.
 *
 * v1: structured log.
 * v2 (deferred): invoke the sprint-planning tRPC procedure or publish a
 *   SprintPlanningStarted event to SNS.
 */
async function runSprintPlanningForTenant(
  tenant: TenantRow,
  utcNow: Date,
): Promise<void> {
  logger.info(
    {
      tenant_id: tenant.tenant_id,
      tenant_name: tenant.name,
      tenant_timezone: tenant.timezone,
      utc_now: utcNow.toISOString(),
    },
    'sprint-planning: starting ceremony for tenant',
  )

  // v2 TODO (deferred): publish SprintPlanningStarted event
  // await snsClient.send(new PublishCommand({
  //   TopicArn: process.env['EVENTS_TOPIC_ARN'],
  //   Message: JSON.stringify({ tenant_id: tenant.tenant_id, triggered_at: utcNow.toISOString() }),
  //   MessageAttributes: {
  //     event_type: { DataType: 'String', StringValue: 'SprintPlanningStarted' },
  //     tenant_id: { DataType: 'String', StringValue: tenant.tenant_id },
  //   },
  // }))
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: EventBridgeScheduledEvent): Promise<void> => {
  const utcNow = new Date(event.time ?? Date.now())

  logger.info(
    { utc_now: utcNow.toISOString(), rule: event['detail-type'] },
    'sprint-planning: Lambda invoked',
  )

  const tenants = await loadActiveTenants()

  if (tenants.length === 0) {
    logger.info('sprint-planning: no active tenants — nothing to do')
    return
  }

  let processed = 0
  let skipped = 0

  for (const tenant of tenants) {
    const inWindow = isWithinSprintPlanningWindow(utcNow, tenant.timezone)

    if (!inWindow) {
      logger.debug(
        { tenant_id: tenant.tenant_id, tenant_timezone: tenant.timezone },
        'sprint-planning: not in ceremony window for this tenant — skipping',
      )
      skipped++
      continue
    }

    await runSprintPlanningForTenant(tenant, utcNow)
    processed++
  }

  logger.info(
    { processed, skipped, total: tenants.length, utc_now: utcNow.toISOString() },
    'sprint-planning: Lambda complete',
  )
}
