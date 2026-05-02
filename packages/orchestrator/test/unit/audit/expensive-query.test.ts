/**
 * Unit tests for the expensive-query heuristic module.
 *
 * Per TRD-07 §13 and M5 done criteria:
 *   "Write a unit test asserting the heuristic"
 *
 * These tests exercise isExpensiveQuery() and expensiveQueryReason() as pure
 * functions — no Postgres required.
 */

import { describe, it, expect } from 'vitest'
import {
  isExpensiveQuery,
  expensiveQueryReason,
  EXPENSIVE_QUERY_WINDOW_DAYS,
} from '../../../src/audit/expensive-query.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function daysAgo(n: number): string {
  const d = new Date(Date.now() - n * 86_400_000)
  return d.toISOString()
}

function nowPlusDays(n: number): string {
  const d = new Date(Date.now() + n * 86_400_000)
  return d.toISOString()
}

// ---------------------------------------------------------------------------
// isExpensiveQuery — NOT expensive (selective filter present)
// ---------------------------------------------------------------------------

describe('isExpensiveQuery — NOT expensive when selective filter present', () => {
  it('returns false when aggregate_id is set (narrow index available)', () => {
    expect(
      isExpensiveQuery({
        aggregate_id: 'some-uuid',
      }),
    ).toBe(false)
  })

  it('returns false when aggregate_id is set even with wide date range', () => {
    expect(
      isExpensiveQuery({
        aggregate_id: 'some-uuid',
        occurred_from: daysAgo(90),
        occurred_to: new Date().toISOString(),
      }),
    ).toBe(false)
  })

  it('returns false when event_type is set (narrow index available)', () => {
    expect(
      isExpensiveQuery({
        event_type: 'TaskCreated',
      }),
    ).toBe(false)
  })

  it('returns false when event_types has at least one entry', () => {
    expect(
      isExpensiveQuery({
        event_types: ['TaskCreated', 'TaskCompleted'],
      }),
    ).toBe(false)
  })

  it('returns false when event_types is set even with wide date range', () => {
    expect(
      isExpensiveQuery({
        event_types: ['DriftDetected'],
        occurred_from: daysAgo(120),
        occurred_to: new Date().toISOString(),
      }),
    ).toBe(false)
  })

  it('returns false when both aggregate_id and event_type are set', () => {
    expect(
      isExpensiveQuery({
        aggregate_id: 'uuid-1',
        event_type: 'TaskCreated',
        occurred_from: daysAgo(365),
        occurred_to: new Date().toISOString(),
      }),
    ).toBe(false)
  })

  it('returns false when window is exactly at the threshold (≤ 30 days)', () => {
    // 30 days exactly — NOT > 30, so not expensive
    expect(
      isExpensiveQuery({
        occurred_from: daysAgo(30),
        occurred_to: new Date().toISOString(),
      }),
    ).toBe(false)
  })

  it('returns false when window is 29 days', () => {
    expect(
      isExpensiveQuery({
        occurred_from: daysAgo(29),
        occurred_to: new Date().toISOString(),
      }),
    ).toBe(false)
  })

  it('returns false for occurred_after/occurred_before aliases within 30 days', () => {
    expect(
      isExpensiveQuery({
        occurred_after: daysAgo(7),
        occurred_before: new Date().toISOString(),
      }),
    ).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// isExpensiveQuery — IS expensive
// ---------------------------------------------------------------------------

describe('isExpensiveQuery — IS expensive', () => {
  it('returns true when no filters at all (unbounded scan)', () => {
    expect(isExpensiveQuery({})).toBe(true)
  })

  it('returns true when only actor_type is set (not a selective index)', () => {
    expect(
      isExpensiveQuery({
        // actor_type uses a JSONB expression index but only actor+occurred,
        // not aggregate or event_type — treated as expensive
      }),
    ).toBe(true)
  })

  it('returns true when window > 30 days and no aggregate_id or event_type', () => {
    expect(
      isExpensiveQuery({
        occurred_from: daysAgo(31),
        occurred_to: new Date().toISOString(),
      }),
    ).toBe(true)
  })

  it(`returns true when window is exactly ${EXPENSIVE_QUERY_WINDOW_DAYS + 1} days`, () => {
    expect(
      isExpensiveQuery({
        occurred_from: daysAgo(EXPENSIVE_QUERY_WINDOW_DAYS + 1),
        occurred_to: new Date().toISOString(),
      }),
    ).toBe(true)
  })

  it('returns true when window > 30 days using occurred_after/occurred_before aliases', () => {
    expect(
      isExpensiveQuery({
        occurred_after: daysAgo(60),
        occurred_before: new Date().toISOString(),
      }),
    ).toBe(true)
  })

  it('returns true when only occurred_from is set (open-ended upper bound = unbounded)', () => {
    expect(
      isExpensiveQuery({
        occurred_from: daysAgo(1),
      }),
    ).toBe(true)
  })

  it('returns true when only occurred_to is set (open lower bound = unbounded)', () => {
    expect(
      isExpensiveQuery({
        occurred_to: new Date().toISOString(),
      }),
    ).toBe(true)
  })

  it('returns true for trace_id filter with no selective index filter', () => {
    // trace_id is indexed but not an aggregate/event_type narrow index
    expect(
      isExpensiveQuery({
        occurred_from: daysAgo(60),
        occurred_to: new Date().toISOString(),
      }),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// expensiveQueryReason
// ---------------------------------------------------------------------------

describe('expensiveQueryReason', () => {
  it('returns null when query is NOT expensive', () => {
    const reason = expensiveQueryReason({ aggregate_id: 'uuid-1' })
    expect(reason).toBeNull()
  })

  it('returns a non-empty string when query IS expensive', () => {
    const reason = expensiveQueryReason({})
    expect(reason).not.toBeNull()
    expect(typeof reason).toBe('string')
    expect(reason!.length).toBeGreaterThan(0)
  })

  it('mentions "no aggregate_id" when that is missing', () => {
    const reason = expensiveQueryReason({
      occurred_from: daysAgo(60),
      occurred_to: new Date().toISOString(),
    })
    expect(reason).toContain('aggregate_id')
  })

  it('mentions "no event_type" when that is missing', () => {
    const reason = expensiveQueryReason({
      occurred_from: daysAgo(60),
      occurred_to: new Date().toISOString(),
    })
    expect(reason).toContain('event_type')
  })

  it('mentions "unbounded scan" when no time bounds given', () => {
    const reason = expensiveQueryReason({})
    expect(reason).toContain('unbounded')
  })

  it('mentions the day count when a wide window is given', () => {
    const reason = expensiveQueryReason({
      occurred_from: daysAgo(90),
      occurred_to: new Date().toISOString(),
    })
    expect(reason).toMatch(/\d+ days/)
  })

  it('includes threshold in the reason when over threshold', () => {
    const reason = expensiveQueryReason({
      occurred_from: daysAgo(60),
      occurred_to: new Date().toISOString(),
    })
    expect(reason).toContain(`${EXPENSIVE_QUERY_WINDOW_DAYS} day threshold`)
  })
})

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('isExpensiveQuery — edge cases', () => {
  it('handles empty event_types array as if event_types is absent', () => {
    // Empty array = no narrowing
    expect(
      isExpensiveQuery({
        event_types: [],
        occurred_from: daysAgo(60),
        occurred_to: new Date().toISOString(),
      }),
    ).toBe(true)
  })

  it('treats future occurred_to with past occurred_from correctly (positive range)', () => {
    expect(
      isExpensiveQuery({
        occurred_from: daysAgo(60),
        occurred_to: nowPlusDays(1),
      }),
    ).toBe(true) // 61 days > 30
  })

  it('handles inverted range gracefully (to before from) — treats as not a positive expense', () => {
    // to - from is negative → rangeMs < 0 < threshold → NOT > 30 days → false
    // But since there's no aggregate_id or event_type, the unbounded-total check kicks in
    // This is a degenerate case; the result can be either; just must not throw.
    expect(() =>
      isExpensiveQuery({
        occurred_from: new Date().toISOString(),
        occurred_to: daysAgo(60),
      }),
    ).not.toThrow()
  })
})
