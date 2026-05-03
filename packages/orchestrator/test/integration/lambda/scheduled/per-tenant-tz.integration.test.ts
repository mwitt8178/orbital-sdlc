/**
 * test/integration/lambda/scheduled/per-tenant-tz.integration.test.ts
 *
 * [Engineer-Sr · Sonnet · run-round8-05-event-bus]
 *
 * Tests that the scheduled Lambda fires for a tenant only at their local 9am
 * (sprint-planning) or 5pm (retro-runner), skipping all other hours.
 *
 * These tests use the exported isWithinSprintPlanningWindow() and
 * isWithinRetroWindow() functions directly (pure functions, no AWS required).
 */

import { describe, it, expect } from 'vitest'
import { isWithinSprintPlanningWindow } from '../../../../src/lambda/scheduled/sprint-planning.js'
import { isWithinRetroWindow } from '../../../../src/lambda/scheduled/retro-runner.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a Date that corresponds to `hour:minute` in a given timezone.
 * Returns a UTC Date object whose local representation in that timezone is
 * exactly `hour:minute`.
 */
function makeDateAtLocalTime(
  hour: number,
  minute: number,
  timezone: string,
): Date {
  // Use a fixed date (2026-05-01) to avoid DST surprises in test assertions.
  // We build a UTC date by computing the UTC offset for the given timezone.
  const dateStr = `2026-05-01T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00`

  // Create a date in the target timezone using Intl.DateTimeFormat
  // to reverse-compute the UTC equivalent.
  const localDate = new Date(dateStr)

  // Get what UTC time gives us `hour:minute` in the timezone.
  // Approach: adjust the naive UTC date by the timezone offset.
  const utcMs = localDate.getTime()

  // Get the local-time string for this UTC moment in the target timezone
  const localParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: 'numeric',
    minute: 'numeric',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(localDate)

  // Extract the actual hour/minute in the target timezone for this UTC time
  const localHour = parseInt(localParts.find((p) => p.type === 'hour')?.value ?? '0', 10)
  const localMinute = parseInt(localParts.find((p) => p.type === 'minute')?.value ?? '0', 10)

  // Compute offset between target local time and actual local time
  const targetMinutes = hour * 60 + minute
  const actualMinutes = localHour * 60 + localMinute
  const offsetMinutes = targetMinutes - actualMinutes

  return new Date(utcMs + offsetMinutes * 60 * 1000)
}

// ---------------------------------------------------------------------------
// Sprint planning window tests (8:45–9:15 local time)
// ---------------------------------------------------------------------------

describe('isWithinSprintPlanningWindow', () => {
  const tz = 'America/New_York'

  it('returns true at exactly 9:00am local time', () => {
    const utcNow = makeDateAtLocalTime(9, 0, tz)
    expect(isWithinSprintPlanningWindow(utcNow, tz)).toBe(true)
  })

  it('returns true at 8:45am local time (window start)', () => {
    const utcNow = makeDateAtLocalTime(8, 45, tz)
    expect(isWithinSprintPlanningWindow(utcNow, tz)).toBe(true)
  })

  it('returns true at 9:15am local time (window end)', () => {
    const utcNow = makeDateAtLocalTime(9, 15, tz)
    expect(isWithinSprintPlanningWindow(utcNow, tz)).toBe(true)
  })

  it('returns false at 8:44am local time (before window)', () => {
    const utcNow = makeDateAtLocalTime(8, 44, tz)
    expect(isWithinSprintPlanningWindow(utcNow, tz)).toBe(false)
  })

  it('returns false at 9:16am local time (after window)', () => {
    const utcNow = makeDateAtLocalTime(9, 16, tz)
    expect(isWithinSprintPlanningWindow(utcNow, tz)).toBe(false)
  })

  it('returns false at noon local time', () => {
    const utcNow = makeDateAtLocalTime(12, 0, tz)
    expect(isWithinSprintPlanningWindow(utcNow, tz)).toBe(false)
  })

  it('returns false at midnight local time', () => {
    const utcNow = makeDateAtLocalTime(0, 0, tz)
    expect(isWithinSprintPlanningWindow(utcNow, tz)).toBe(false)
  })

  it('works for a tenant in a different timezone (UTC+5:30 IST)', () => {
    const istTz = 'Asia/Kolkata'
    // IST is UTC+5:30; 9am IST = 3:30am UTC
    const utcAt330am = makeDateAtLocalTime(9, 0, istTz)
    expect(isWithinSprintPlanningWindow(utcAt330am, istTz)).toBe(true)
  })

  it('a UTC tenant does not trigger at 9am IST (timezone isolation)', () => {
    // When it's 9am IST, it's 3:30am UTC — not in UTC 9am window
    const utcTz = 'UTC'
    const istTz = 'Asia/Kolkata'
    const utcAt930IST = makeDateAtLocalTime(9, 0, istTz) // 3:30am UTC
    expect(isWithinSprintPlanningWindow(utcAt930IST, utcTz)).toBe(false)
  })

  it('returns false for invalid timezone (defensive)', () => {
    const utcNow = new Date()
    expect(isWithinSprintPlanningWindow(utcNow, 'Invalid/Timezone')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Retro window tests (16:45–17:15 local time)
// ---------------------------------------------------------------------------

describe('isWithinRetroWindow', () => {
  const tz = 'Europe/London'

  it('returns true at exactly 5:00pm local time', () => {
    const utcNow = makeDateAtLocalTime(17, 0, tz)
    expect(isWithinRetroWindow(utcNow, tz)).toBe(true)
  })

  it('returns true at 4:45pm local time (window start)', () => {
    const utcNow = makeDateAtLocalTime(16, 45, tz)
    expect(isWithinRetroWindow(utcNow, tz)).toBe(true)
  })

  it('returns true at 5:15pm local time (window end)', () => {
    const utcNow = makeDateAtLocalTime(17, 15, tz)
    expect(isWithinRetroWindow(utcNow, tz)).toBe(true)
  })

  it('returns false at 4:44pm (before window)', () => {
    const utcNow = makeDateAtLocalTime(16, 44, tz)
    expect(isWithinRetroWindow(utcNow, tz)).toBe(false)
  })

  it('returns false at 5:16pm (after window)', () => {
    const utcNow = makeDateAtLocalTime(17, 16, tz)
    expect(isWithinRetroWindow(utcNow, tz)).toBe(false)
  })

  it('returns false at 9am (sprint planning time)', () => {
    const utcNow = makeDateAtLocalTime(9, 0, tz)
    expect(isWithinRetroWindow(utcNow, tz)).toBe(false)
  })

  it('works for a US Pacific tenant (UTC-8/UTC-7)', () => {
    const ptTz = 'America/Los_Angeles'
    const utcAt5pmPT = makeDateAtLocalTime(17, 0, ptTz)
    expect(isWithinRetroWindow(utcAt5pmPT, ptTz)).toBe(true)
  })

  it('tenant in PT is not triggered by London 5pm (timezone isolation)', () => {
    const londonTz = 'Europe/London'
    const ptTz = 'America/Los_Angeles'
    // When it's 5pm London, it's ~9am PT in winter
    const utcAt5pmLondon = makeDateAtLocalTime(17, 0, londonTz)
    // PT should not be in retro window at this time
    expect(isWithinRetroWindow(utcAt5pmLondon, ptTz)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Cross-verify sprint-planning and retro windows don't overlap
// ---------------------------------------------------------------------------

describe('Sprint-planning and retro windows do not overlap', () => {
  it('9am is in sprint window but NOT in retro window', () => {
    const tz = 'UTC'
    const at9am = makeDateAtLocalTime(9, 0, tz)
    expect(isWithinSprintPlanningWindow(at9am, tz)).toBe(true)
    expect(isWithinRetroWindow(at9am, tz)).toBe(false)
  })

  it('5pm is in retro window but NOT in sprint window', () => {
    const tz = 'UTC'
    const at5pm = makeDateAtLocalTime(17, 0, tz)
    expect(isWithinSprintPlanningWindow(at5pm, tz)).toBe(false)
    expect(isWithinRetroWindow(at5pm, tz)).toBe(true)
  })
})
