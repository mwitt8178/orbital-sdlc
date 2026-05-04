/**
 * cost/billing.ts — read-side aggregations powering /settings/billing.
 *
 * [Engineer-Principal · Opus · run-settings-billing]
 *
 * All queries read from cost_ledger. They never mutate state. Categorisation
 * lives in `./categories.ts` so it is unit-testable independently.
 *
 * Functions:
 *   - billingMonthSummary  — total + monthly cap + pct used for the active month
 *   - billingDailySeries   — { date, costUsd }[] for the active month (zero-filled)
 *   - billingByCategory    — totals per BillingCategory for a date range
 *   - billingTopExpensive  — top N stories ordered by spend
 *   - billingProjection    — projected month-end spend given recent velocity
 *   - billingExportCsv     — CSV string of cost_ledger rows in a date range
 *   - billingUpdateBudget  — patch monthly cap / hard-stop / digest emails
 */

import { eq, and, sql as dSQL, desc } from 'drizzle-orm'
import type { DB } from '@orbital/db'
import { costLedger, costBudgets } from '@orbital/db'
import { categorize, BILLING_CATEGORIES, type BillingCategory } from './categories.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DailySpend {
  date: string         // ISO date (YYYY-MM-DD)
  costUsd: number
}

export interface CategoryTotal {
  category: BillingCategory
  costUsd: number
  entryCount: number
}

export interface ExpensiveStory {
  storyId: string
  costUsd: number
  entryCount: number
  firstAt: string
  lastAt: string
}

export interface ProjectBillingSummary {
  projectId: string
  monthStart: string
  monthEnd: string
  monthCostUsd: number
  totalCostUsd: number
  monthlyCapUsd: number | null
  pctUsed: number          // monthCost / monthlyCap (0 if no cap)
  hardStop: boolean
  digestEmails: string[]
  entryCount: number
}

export interface MonthProjection {
  projectId: string
  windowDays: number
  avgDailyUsd: number
  daysRemaining: number
  projectedMonthEndUsd: number
  /** Best estimate of total month spend (actual + projected for remaining days). */
  forecastedMonthSpendUsd: number
}

export interface UpdateBudgetPatch {
  monthlyCapUsd?: number | null
  hardStop?: boolean
  digestEmails?: string[]
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function startOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1, 0, 0, 0, 0))
}

function endOfMonthUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0))
}

function daysBetween(a: Date, b: Date): number {
  const ms = b.getTime() - a.getTime()
  return Math.max(0, Math.ceil(ms / 86_400_000))
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10)
}

/**
 * Fill missing days between fromIso (inclusive) and toIso (exclusive) with
 * zero entries. The DB returns only days that had spend; the chart needs
 * a continuous series.
 */
function zeroFillDailySeries(
  rows: Array<{ date: string; costUsd: number }>,
  fromIso: string,
  toIso: string,
): DailySpend[] {
  const map = new Map(rows.map((r) => [r.date, r.costUsd]))
  const out: DailySpend[] = []
  const cursor = new Date(`${fromIso}T00:00:00.000Z`)
  const end = new Date(`${toIso}T00:00:00.000Z`)
  while (cursor < end) {
    const key = isoDate(cursor)
    out.push({ date: key, costUsd: map.get(key) ?? 0 })
    cursor.setUTCDate(cursor.getUTCDate() + 1)
  }
  return out
}

// ---------------------------------------------------------------------------
// Month summary + budget
// ---------------------------------------------------------------------------

export async function billingMonthSummary(
  db: DB,
  projectId: string,
  now: Date = new Date(),
): Promise<ProjectBillingSummary> {
  const monthStart = startOfMonthUtc(now)
  const monthEnd = endOfMonthUtc(now)

  // Aggregate month spend.
  const monthRows = await db
    .select({
      total: dSQL<string>`COALESCE(SUM(${costLedger.costUsd}), 0)`,
      count: dSQL<number>`COUNT(*)::int`,
    })
    .from(costLedger)
    .where(
      and(
        eq(costLedger.projectId, projectId),
        dSQL`${costLedger.occurredAt} >= ${monthStart.toISOString()}`,
        dSQL`${costLedger.occurredAt} <  ${monthEnd.toISOString()}`,
      ),
    )

  // Aggregate all-time spend (cheap on the project_time index).
  const totalRows = await db
    .select({
      total: dSQL<string>`COALESCE(SUM(${costLedger.costUsd}), 0)`,
    })
    .from(costLedger)
    .where(eq(costLedger.projectId, projectId))

  const monthCostUsd = Number(monthRows[0]?.total ?? 0)
  const totalCostUsd = Number(totalRows[0]?.total ?? 0)
  const entryCount = Number(monthRows[0]?.count ?? 0)

  // Read project-scope budget for monthly cap fields.
  const budget = await db
    .select()
    .from(costBudgets)
    .where(
      and(
        eq(costBudgets.scope, 'project'),
        eq(costBudgets.scopeId, projectId),
        eq(costBudgets.active, true),
      ),
    )
    .limit(1)

  const b = budget[0]
  const monthlyCapUsd = b?.monthlyCapUsd != null ? Number(b.monthlyCapUsd) : null
  const pctUsed = monthlyCapUsd && monthlyCapUsd > 0 ? monthCostUsd / monthlyCapUsd : 0

  return {
    projectId,
    monthStart: monthStart.toISOString(),
    monthEnd: monthEnd.toISOString(),
    monthCostUsd,
    totalCostUsd,
    monthlyCapUsd,
    pctUsed,
    hardStop: b?.hardStop ?? false,
    digestEmails: b?.digestEmails ?? [],
    entryCount,
  }
}

// ---------------------------------------------------------------------------
// Daily series (sparkline + month chart)
// ---------------------------------------------------------------------------

export async function billingDailySeries(
  db: DB,
  projectId: string,
  fromDate: Date,
  toDate: Date,
): Promise<DailySpend[]> {
  // Bucket by UTC date.
  const rows = await db
    .select({
      date: dSQL<string>`to_char(${costLedger.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`,
      total: dSQL<string>`COALESCE(SUM(${costLedger.costUsd}), 0)`,
    })
    .from(costLedger)
    .where(
      and(
        eq(costLedger.projectId, projectId),
        dSQL`${costLedger.occurredAt} >= ${fromDate.toISOString()}`,
        dSQL`${costLedger.occurredAt} <  ${toDate.toISOString()}`,
      ),
    )
    .groupBy(dSQL`to_char(${costLedger.occurredAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD')`)

  const mapped = rows.map((r) => ({ date: r.date, costUsd: Number(r.total) }))
  return zeroFillDailySeries(mapped, isoDate(fromDate), isoDate(toDate))
}

// ---------------------------------------------------------------------------
// By category
// ---------------------------------------------------------------------------

export async function billingByCategory(
  db: DB,
  projectId: string,
  fromDate: Date,
  toDate: Date,
): Promise<CategoryTotal[]> {
  const rows = await db
    .select({
      personaId: costLedger.personaId,
      taskId: costLedger.taskId,
      cost: costLedger.costUsd,
    })
    .from(costLedger)
    .where(
      and(
        eq(costLedger.projectId, projectId),
        dSQL`${costLedger.occurredAt} >= ${fromDate.toISOString()}`,
        dSQL`${costLedger.occurredAt} <  ${toDate.toISOString()}`,
      ),
    )

  const acc = new Map<BillingCategory, { costUsd: number; entryCount: number }>()
  for (const cat of BILLING_CATEGORIES) acc.set(cat, { costUsd: 0, entryCount: 0 })

  for (const r of rows) {
    const cat = categorize({ personaId: r.personaId ?? null, taskId: r.taskId ?? null })
    const slot = acc.get(cat)!
    slot.costUsd += Number(r.cost)
    slot.entryCount += 1
  }

  return BILLING_CATEGORIES.map((cat) => ({
    category: cat,
    costUsd: acc.get(cat)!.costUsd,
    entryCount: acc.get(cat)!.entryCount,
  }))
}

// ---------------------------------------------------------------------------
// Top expensive stories
// ---------------------------------------------------------------------------

export async function billingTopExpensive(
  db: DB,
  projectId: string,
  limit: number,
  fromDate: Date,
  toDate: Date,
): Promise<ExpensiveStory[]> {
  const rows = await db
    .select({
      storyId: costLedger.taskId,
      total: dSQL<string>`COALESCE(SUM(${costLedger.costUsd}), 0)`,
      count: dSQL<number>`COUNT(*)::int`,
      firstAt: dSQL<Date>`MIN(${costLedger.occurredAt})`,
      lastAt: dSQL<Date>`MAX(${costLedger.occurredAt})`,
    })
    .from(costLedger)
    .where(
      and(
        eq(costLedger.projectId, projectId),
        dSQL`${costLedger.taskId} IS NOT NULL`,
        dSQL`${costLedger.occurredAt} >= ${fromDate.toISOString()}`,
        dSQL`${costLedger.occurredAt} <  ${toDate.toISOString()}`,
      ),
    )
    .groupBy(costLedger.taskId)
    .orderBy(desc(dSQL`SUM(${costLedger.costUsd})`))
    .limit(limit)

  return rows
    .filter((r) => r.storyId != null)
    .map((r) => ({
      storyId: r.storyId as string,
      costUsd: Number(r.total),
      entryCount: Number(r.count),
      firstAt: r.firstAt instanceof Date ? r.firstAt.toISOString() : String(r.firstAt),
      lastAt: r.lastAt instanceof Date ? r.lastAt.toISOString() : String(r.lastAt),
    }))
}

// ---------------------------------------------------------------------------
// Projection — simple velocity model
// ---------------------------------------------------------------------------

export async function billingProjection(
  db: DB,
  projectId: string,
  now: Date = new Date(),
): Promise<MonthProjection> {
  const monthStart = startOfMonthUtc(now)
  const monthEnd = endOfMonthUtc(now)
  const lookbackStart = new Date(now.getTime() - 7 * 86_400_000)

  // Average daily spend over the trailing 7 days (clipped to month start).
  const windowStart = lookbackStart > monthStart ? lookbackStart : monthStart
  const rows = await db
    .select({
      total: dSQL<string>`COALESCE(SUM(${costLedger.costUsd}), 0)`,
    })
    .from(costLedger)
    .where(
      and(
        eq(costLedger.projectId, projectId),
        dSQL`${costLedger.occurredAt} >= ${windowStart.toISOString()}`,
        dSQL`${costLedger.occurredAt} <  ${now.toISOString()}`,
      ),
    )

  const windowDays = Math.max(1, daysBetween(windowStart, now))
  const windowSpend = Number(rows[0]?.total ?? 0)
  const avgDailyUsd = windowSpend / windowDays

  const daysRemaining = daysBetween(now, monthEnd)
  const projectedRemainder = avgDailyUsd * daysRemaining

  // Month-to-date actual spend
  const monthRows = await db
    .select({
      total: dSQL<string>`COALESCE(SUM(${costLedger.costUsd}), 0)`,
    })
    .from(costLedger)
    .where(
      and(
        eq(costLedger.projectId, projectId),
        dSQL`${costLedger.occurredAt} >= ${monthStart.toISOString()}`,
        dSQL`${costLedger.occurredAt} <  ${now.toISOString()}`,
      ),
    )
  const monthToDate = Number(monthRows[0]?.total ?? 0)

  return {
    projectId,
    windowDays,
    avgDailyUsd,
    daysRemaining,
    projectedMonthEndUsd: projectedRemainder,
    forecastedMonthSpendUsd: monthToDate + projectedRemainder,
  }
}

// ---------------------------------------------------------------------------
// CSV export
// ---------------------------------------------------------------------------

const CSV_COLUMNS = [
  'occurred_at',
  'project_id',
  'sprint_id',
  'task_id',
  'worker_id',
  'persona_id',
  'category',
  'model',
  'provider',
  'input_tokens',
  'output_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'cost_usd',
  'request_id',
] as const

function csvEscape(value: unknown): string {
  if (value == null) return ''
  const s = String(value)
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`
  }
  return s
}

export async function billingExportCsv(
  db: DB,
  projectId: string,
  fromDate: Date,
  toDate: Date,
  maxRows: number = 50_000,
): Promise<{ csv: string; rowCount: number; truncated: boolean }> {
  const rows = await db
    .select()
    .from(costLedger)
    .where(
      and(
        eq(costLedger.projectId, projectId),
        dSQL`${costLedger.occurredAt} >= ${fromDate.toISOString()}`,
        dSQL`${costLedger.occurredAt} <  ${toDate.toISOString()}`,
      ),
    )
    .orderBy(desc(costLedger.occurredAt))
    .limit(maxRows + 1)

  const truncated = rows.length > maxRows
  const pageRows = truncated ? rows.slice(0, maxRows) : rows

  const lines: string[] = []
  lines.push(CSV_COLUMNS.join(','))
  for (const r of pageRows) {
    const category = categorize({ personaId: r.personaId ?? null, taskId: r.taskId ?? null })
    lines.push(
      [
        r.occurredAt.toISOString(),
        r.projectId,
        r.sprintId ?? '',
        r.taskId ?? '',
        r.workerId ?? '',
        r.personaId ?? '',
        category,
        r.model,
        r.provider,
        r.inputTokens,
        r.outputTokens,
        r.cacheReadTokens,
        r.cacheWriteTokens,
        r.costUsd,
        r.requestId ?? '',
      ]
        .map(csvEscape)
        .join(','),
    )
  }

  return { csv: lines.join('\n') + '\n', rowCount: pageRows.length, truncated }
}

// ---------------------------------------------------------------------------
// Update budget patch
// ---------------------------------------------------------------------------

export async function billingUpdateBudget(
  db: DB,
  projectId: string,
  patch: UpdateBudgetPatch,
  now: Date = new Date(),
): Promise<ProjectBillingSummary> {
  const existing = await db
    .select()
    .from(costBudgets)
    .where(
      and(
        eq(costBudgets.scope, 'project'),
        eq(costBudgets.scopeId, projectId),
        eq(costBudgets.active, true),
      ),
    )
    .limit(1)

  const current = existing[0]

  if (current) {
    const update: Record<string, unknown> = { updatedAt: now }
    if (patch.monthlyCapUsd !== undefined) {
      update.monthlyCapUsd = patch.monthlyCapUsd == null ? null : String(patch.monthlyCapUsd)
    }
    if (patch.hardStop !== undefined) update.hardStop = patch.hardStop
    if (patch.digestEmails !== undefined) update.digestEmails = patch.digestEmails

    await db
      .update(costBudgets)
      .set(update)
      .where(eq(costBudgets.budgetId, current.budgetId))
  } else {
    // No project budget yet — synthesize a row so the patch sticks.
    const { uuidv7 } = await import('uuidv7')
    await db.insert(costBudgets).values({
      budgetId: uuidv7(),
      scope: 'project',
      scopeId: projectId,
      // hardCapUsd is required by the schema; default to a very high value
      // so it has no enforcement effect when only the monthly cap is set.
      hardCapUsd: '999999.99',
      softThresholdPct: 80,
      onSoft: 'alert',
      onHard: 'alert_only',
      monthlyCapUsd: patch.monthlyCapUsd == null ? null : String(patch.monthlyCapUsd ?? null),
      hardStop: patch.hardStop ?? false,
      digestEmails: patch.digestEmails ?? [],
      active: true,
      createdAt: now,
      updatedAt: now,
    })
  }

  return billingMonthSummary(db, projectId, now)
}
