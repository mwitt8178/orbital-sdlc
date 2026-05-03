/**
 * lambda/scheduled/retro-runner.ts — EventBridge-triggered retro ceremony.
 *
 * [Engineer-Sr · Sonnet · run-round8-05-event-bus]
 *
 * Fires every day at 5pm UTC (EventBridge cron rule).
 *
 * Same per-tenant timezone pattern as sprint-planning.ts:
 *  - Reads active tenants.
 *  - For each tenant: checks if their local time is within the retro window
 *    (16:45–17:15 local time — 30-minute window centered on 5pm).
 *  - If yes: kick off retro ceremony for that tenant.
 *  - If no: skip.
 *
 * v1: structured log per tenant.
 * v2 (deferred): invoke the retro tRPC procedure or publish RetroStarted event.
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
 * Check if the current UTC time falls within the retro window for a given
 * tenant timezone.
 *
 * Window: 16:45–17:15 local time (30-minute window centered on 5pm).
 */
export function isWithinRetroWindow(
  utcNow: Date,
  tenantTimezone: string,
): boolean {
  try {
    const localTimeStr = utcNow.toLocaleString('en-US', {
      timeZone: tenantTimezone,
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    })

    const [hourStr, minuteStr] = localTimeStr.split(':')
    const hour = parseInt(hourStr ?? '0', 10)
    const minute = parseInt(minuteStr ?? '0', 10)
    const localMinutes = hour * 60 + minute

    // Window: 16:45 (1005 min) to 17:15 (1035 min)
    const windowStart = 16 * 60 + 45 // 1005
    const windowEnd = 17 * 60 + 15   // 1035

    return localMinutes >= windowStart && localMinutes <= windowEnd
  } catch (err) {
    logger.warn(
      { tenantTimezone, err },
      'retro-runner: failed to parse tenant timezone — defaulting to skip',
    )
    return false
  }
}

// ---------------------------------------------------------------------------
// Tenant loader (v1 stub)
// ---------------------------------------------------------------------------

async function loadActiveTenants(): Promise<TenantRow[]> {
  // v2 TODO (deferred): query Aurora via RDS Proxy
  logger.debug('retro-runner: v1 stub — no tenants loaded from DB (deferred)')
  return []
}

async function runRetroForTenant(tenant: TenantRow, utcNow: Date): Promise<void> {
  logger.info(
    {
      tenant_id: tenant.tenant_id,
      tenant_name: tenant.name,
      tenant_timezone: tenant.timezone,
      utc_now: utcNow.toISOString(),
    },
    'retro-runner: starting retro for tenant',
  )

  // v2 TODO (deferred): publish RetroStarted event
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: EventBridgeScheduledEvent): Promise<void> => {
  const utcNow = new Date(event.time ?? Date.now())

  logger.info(
    { utc_now: utcNow.toISOString(), rule: event['detail-type'] },
    'retro-runner: Lambda invoked',
  )

  const tenants = await loadActiveTenants()

  if (tenants.length === 0) {
    logger.info('retro-runner: no active tenants — nothing to do')
    return
  }

  let processed = 0
  let skipped = 0

  for (const tenant of tenants) {
    const inWindow = isWithinRetroWindow(utcNow, tenant.timezone)

    if (!inWindow) {
      logger.debug(
        { tenant_id: tenant.tenant_id, tenant_timezone: tenant.timezone },
        'retro-runner: not in retro window for this tenant — skipping',
      )
      skipped++
      continue
    }

    await runRetroForTenant(tenant, utcNow)
    processed++
  }

  logger.info(
    { processed, skipped, total: tenants.length, utc_now: utcNow.toISOString() },
    'retro-runner: Lambda complete',
  )
}
