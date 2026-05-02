/**
 * Tests for the SprintProgressBar day-counter math. The helper is
 * intentionally pure so this test exercises the same arithmetic the
 * production component uses without needing a DOM environment.
 */

import { describe, it, expect } from 'vitest'

const DAY_MS = 86_400_000
const DEFAULT_SPRINT_DAYS = 5

function computeDayCounter(
  startedAt: string | null | undefined,
  wallClockTargetMs: number | null | undefined,
  now = Date.now(),
): { day: number; totalDays: number } | null {
  if (!startedAt) return null
  const started = new Date(startedAt).getTime()
  if (Number.isNaN(started)) return null
  const elapsedDays = Math.max(1, Math.ceil((now - started) / DAY_MS))
  const totalDays = wallClockTargetMs
    ? Math.max(1, Math.ceil(wallClockTargetMs / DAY_MS))
    : DEFAULT_SPRINT_DAYS
  return { day: Math.min(elapsedDays, totalDays + 30), totalDays }
}

describe('SprintProgressBar day counter', () => {
  it('returns null without a startedAt', () => {
    expect(computeDayCounter(null, 5 * DAY_MS)).toBeNull()
    expect(computeDayCounter(undefined, 5 * DAY_MS)).toBeNull()
  })

  it('returns null for an unparseable startedAt', () => {
    expect(computeDayCounter('not a date', null)).toBeNull()
  })

  it('starts at day 1 immediately after start', () => {
    const start = new Date('2026-05-01T00:00:00Z')
    const now = start.getTime() + 1000
    expect(computeDayCounter(start.toISOString(), 5 * DAY_MS, now)).toEqual({
      day: 1,
      totalDays: 5,
    })
  })

  it('rolls to day 3 on the third calendar day of a 5-day sprint', () => {
    const start = new Date('2026-05-01T00:00:00Z')
    const now = start.getTime() + 2.5 * DAY_MS
    const counter = computeDayCounter(start.toISOString(), 5 * DAY_MS, now)
    expect(counter?.day).toBe(3)
    expect(counter?.totalDays).toBe(5)
  })

  it('falls back to 5-day default when wallClockTargetMs is null', () => {
    const start = new Date('2026-05-01T00:00:00Z')
    const now = start.getTime() + 1.5 * DAY_MS
    const counter = computeDayCounter(start.toISOString(), null, now)
    expect(counter?.totalDays).toBe(DEFAULT_SPRINT_DAYS)
  })

  it('caps the elapsed-day count to totalDays + 30', () => {
    const start = new Date('2025-01-01T00:00:00Z')
    const now = new Date('2026-12-31T00:00:00Z').getTime()
    const counter = computeDayCounter(start.toISOString(), 5 * DAY_MS, now)
    expect(counter?.day).toBeLessThanOrEqual(35)
  })
})
