/**
 * lambda/scheduled/cost-digest.ts — Daily cost digest email via SES.
 *
 * [Engineer-Sr · Sonnet · run-cost-guardrails-2026-05-04]
 *
 * Fires at 9am tenant local time (EventBridge cron rule, similar to retro-runner).
 *
 * Per-tenant behavior:
 *   1. Check whether tenant's local time is within the 9am digest window (08:45–09:15).
 *   2. Load the tenant's digest config (email address, project IDs).
 *   3. For each project:
 *      a. Sum MTD spend from cost_ledger.
 *      b. Fetch active budget cap from cost_budgets.
 *      c. Count recent enforcement decisions from cost_enforcement_log (last 24h).
 *   4. Send a structured summary email via SES.
 *
 * SES send is skipped when ORBITAL_SES_FROM_EMAIL is unset (local/test environments).
 *
 * Required env vars (production):
 *   ORBITAL_SES_FROM_EMAIL  — verified "from" address (e.g. noreply@orbital.app)
 *   ORBITAL_SES_REGION      — AWS region for SES (defaults to AWS_REGION)
 *   DATABASE_URL            — Aurora/Postgres connection string
 */

import { SESClient, SendEmailCommand } from '@aws-sdk/client-ses'
import { logger } from '../../config/logger.js'
import { getDb } from '@orbital/db'
import { costLedger, costBudgets, costEnforcementLog } from '@orbital/db'
import { eq, and, sum, count, gte } from 'drizzle-orm'
import { sql as dSQL } from 'drizzle-orm'

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

interface DigestTenantRow {
  tenant_id: string
  name: string
  timezone: string
  digest_email: string | null
  project_ids: string[]
}

interface ProjectDigest {
  projectId: string
  projectName: string
  mtdSpendUsd: number
  hardCapUsd: number | null
  pctUsed: number
  blockCount24h: number
  allowCount24h: number
}

// ---------------------------------------------------------------------------
// Digest window check (same pattern as retro-runner)
// ---------------------------------------------------------------------------

/**
 * Returns true if utcNow falls within the 9am digest window (08:45–09:15) in
 * the given tenant timezone.
 */
export function isWithinDigestWindow(utcNow: Date, tenantTimezone: string): boolean {
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

    // Window: 08:45 (525 min) to 09:15 (555 min)
    const windowStart = 8 * 60 + 45 // 525
    const windowEnd   = 9 * 60 + 15 // 555

    return localMinutes >= windowStart && localMinutes <= windowEnd
  } catch (err) {
    logger.warn(
      { tenantTimezone, err },
      'cost-digest: failed to parse tenant timezone — defaulting to skip',
    )
    return false
  }
}

// ---------------------------------------------------------------------------
// Tenant loader
// ---------------------------------------------------------------------------

async function loadDigestTenants(): Promise<DigestTenantRow[]> {
  // v2 TODO (deferred): query install_state + tenants table for active tenants
  // with digest_email configured.
  //
  // v1: reads ORBITAL_DIGEST_TENANT env var as a JSON blob for single-tenant
  // or self-hosted setups. This lets operators configure the digest without
  // a full multi-tenant DB query.
  const envBlob = process.env['ORBITAL_DIGEST_TENANT']
  if (!envBlob) {
    logger.debug('cost-digest: ORBITAL_DIGEST_TENANT not set — no tenants to digest')
    return []
  }

  try {
    const parsed = JSON.parse(envBlob)
    if (Array.isArray(parsed)) return parsed as DigestTenantRow[]
    return [parsed] as DigestTenantRow[]
  } catch (err) {
    logger.warn({ err }, 'cost-digest: failed to parse ORBITAL_DIGEST_TENANT — skipping')
    return []
  }
}

// ---------------------------------------------------------------------------
// Per-project digest data
// ---------------------------------------------------------------------------

async function buildProjectDigest(projectId: string, projectName: string): Promise<ProjectDigest> {
  const { db } = await getDb()

  // MTD window
  const now = new Date()
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1)
  const monthStartIso = monthStart.toISOString()

  // MTD spend
  const mtdRows = await db
    .select({ total: sum(costLedger.costUsd) })
    .from(costLedger)
    .where(
      and(
        eq(costLedger.projectId, projectId),
        dSQL`${costLedger.occurredAt} >= ${monthStartIso}`,
      ),
    )
  const mtdSpendUsd = Number(mtdRows[0]?.total ?? 0)

  // Active budget cap
  const budgetRows = await db
    .select({
      hardCapUsd:       costBudgets.hardCapUsd,
      softThresholdPct: costBudgets.softThresholdPct,
    })
    .from(costBudgets)
    .where(
      and(
        eq(costBudgets.scope, 'project'),
        eq(costBudgets.scopeId, projectId),
        eq(costBudgets.active, true),
      ),
    )
    .limit(1)

  const hardCapUsd = budgetRows[0] ? Number(budgetRows[0].hardCapUsd) : null
  const pctUsed = hardCapUsd ? mtdSpendUsd / hardCapUsd : 0

  // Enforcement decisions in last 24h
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000)
  const yesterdayIso = yesterday.toISOString()

  const decisionRows = await db
    .select({
      decision: costEnforcementLog.decision,
      cnt:      count(),
    })
    .from(costEnforcementLog)
    .where(
      and(
        eq(costEnforcementLog.projectId, projectId),
        dSQL`${costEnforcementLog.createdAt} >= ${yesterdayIso}`,
      ),
    )
    .groupBy(costEnforcementLog.decision)

  let blockCount24h = 0
  let allowCount24h = 0
  for (const row of decisionRows) {
    const n = Number(row.cnt)
    if (row.decision === 'block') blockCount24h += n
    else if (row.decision === 'allow') allowCount24h += n
  }

  return {
    projectId,
    projectName,
    mtdSpendUsd,
    hardCapUsd,
    pctUsed,
    blockCount24h,
    allowCount24h,
  }
}

// ---------------------------------------------------------------------------
// Email builder
// ---------------------------------------------------------------------------

function buildDigestHtml(tenantName: string, projects: ProjectDigest[]): string {
  const rows = projects
    .map((p) => {
      const pct = Math.round(p.pctUsed * 100)
      const barFill = Math.min(pct, 100)
      const barColor = pct >= 100 ? '#ef4444' : pct >= 80 ? '#f59e0b' : '#10b981'
      const blockBadge =
        p.blockCount24h > 0
          ? `<span style="background:#fee2e2;color:#b91c1c;padding:2px 6px;border-radius:4px;font-size:11px;font-weight:600">${p.blockCount24h} blocked</span>`
          : ''

      return `
        <tr style="border-bottom:1px solid #e2e8f0">
          <td style="padding:10px 0;font-weight:500">${p.projectName}</td>
          <td style="padding:10px 8px;font-family:monospace">$${p.mtdSpendUsd.toFixed(4)}</td>
          <td style="padding:10px 8px;font-family:monospace">${p.hardCapUsd != null ? `$${p.hardCapUsd.toFixed(2)}` : '—'}</td>
          <td style="padding:10px 8px">
            <div style="background:#e2e8f0;border-radius:4px;height:8px;width:80px">
              <div style="background:${barColor};width:${barFill}%;height:8px;border-radius:4px"></div>
            </div>
            <span style="font-size:11px;color:#64748b">${pct}%</span>
          </td>
          <td style="padding:10px 8px">${blockBadge}</td>
        </tr>`
    })
    .join('')

  return `
    <html><body style="font-family:system-ui,-apple-system,sans-serif;color:#1e293b;margin:0;padding:24px;background:#f8fafc">
      <div style="max-width:600px;margin:0 auto;background:white;border-radius:8px;border:1px solid #e2e8f0;overflow:hidden">
        <div style="background:#1e293b;padding:20px 24px">
          <p style="margin:0;color:#94a3b8;font-size:12px;text-transform:uppercase;letter-spacing:.05em">Orbital</p>
          <h1 style="margin:4px 0 0;color:white;font-size:18px">Daily cost digest — ${tenantName}</h1>
        </div>
        <div style="padding:24px">
          <table style="width:100%;border-collapse:collapse">
            <thead>
              <tr style="border-bottom:2px solid #e2e8f0;text-align:left">
                <th style="padding-bottom:8px;font-size:12px;color:#64748b;font-weight:600">Project</th>
                <th style="padding-bottom:8px;font-size:12px;color:#64748b;font-weight:600">MTD Spend</th>
                <th style="padding-bottom:8px;font-size:12px;color:#64748b;font-weight:600">Cap</th>
                <th style="padding-bottom:8px;font-size:12px;color:#64748b;font-weight:600">Used</th>
                <th style="padding-bottom:8px;font-size:12px;color:#64748b;font-weight:600">Blocks (24h)</th>
              </tr>
            </thead>
            <tbody>${rows}</tbody>
          </table>
          <p style="margin:20px 0 0;font-size:12px;color:#94a3b8">
            View details in your Orbital workspace at <a href="/settings/billing" style="color:#6366f1">/settings/billing</a>.
          </p>
        </div>
      </div>
    </body></html>`
}

// ---------------------------------------------------------------------------
// SES send
// ---------------------------------------------------------------------------

async function sendDigestEmail(
  toEmail: string,
  tenantName: string,
  projects: ProjectDigest[],
): Promise<void> {
  const fromEmail = process.env['ORBITAL_SES_FROM_EMAIL']
  if (!fromEmail) {
    logger.info(
      { toEmail, tenantName },
      'cost-digest: ORBITAL_SES_FROM_EMAIL not set — skipping SES send (logged only)',
    )
    // Log the digest content so operators can verify it in CloudWatch.
    for (const p of projects) {
      logger.info(
        {
          tenant_id: 'digest',
          project_id: p.projectId,
          mtd_spend_usd: p.mtdSpendUsd,
          hard_cap_usd:  p.hardCapUsd,
          pct_used:      Math.round(p.pctUsed * 100),
          block_count_24h: p.blockCount24h,
        },
        'cost-digest: project summary',
      )
    }
    return
  }

  const sesRegion = process.env['ORBITAL_SES_REGION'] ?? process.env['AWS_REGION'] ?? 'us-east-1'
  const ses = new SESClient({ region: sesRegion })

  const html = buildDigestHtml(tenantName, projects)
  const subject = `Orbital daily cost digest — ${tenantName} (${new Date().toLocaleDateString()})`

  await ses.send(
    new SendEmailCommand({
      Source: fromEmail,
      Destination: { ToAddresses: [toEmail] },
      Message: {
        Subject: { Data: subject, Charset: 'UTF-8' },
        Body: { Html: { Data: html, Charset: 'UTF-8' } },
      },
    }),
  )

  logger.info(
    { toEmail, tenantName, projectCount: projects.length },
    'cost-digest: digest email sent',
  )
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export const handler = async (event: EventBridgeScheduledEvent): Promise<void> => {
  const utcNow = new Date(event.time ?? Date.now())

  logger.info(
    { tenant_id: 'system', utc_now: utcNow.toISOString(), rule: event['detail-type'] },
    'cost-digest: Lambda invoked',
  )

  const tenants = await loadDigestTenants()

  for (const tenant of tenants) {
    if (!isWithinDigestWindow(utcNow, tenant.timezone)) {
      logger.debug(
        { tenant_id: tenant.tenant_id, timezone: tenant.timezone },
        'cost-digest: outside digest window — skipping',
      )
      continue
    }

    if (!tenant.digest_email) {
      logger.debug(
        { tenant_id: tenant.tenant_id },
        'cost-digest: no digest_email configured — skipping',
      )
      continue
    }

    try {
      const projectDigests = await Promise.all(
        tenant.project_ids.map((pid) => buildProjectDigest(pid, pid)),
      )

      await sendDigestEmail(tenant.digest_email, tenant.name, projectDigests)
    } catch (err) {
      logger.error(
        { tenant_id: tenant.tenant_id, err },
        'cost-digest: failed to build/send digest for tenant',
      )
    }
  }

  logger.info(
    { tenant_id: 'system', tenant_count: tenants.length },
    'cost-digest: Lambda complete',
  )
}
