/**
 * Unit tests for the escalation-dedupe helper. Pure logic — no React or DOM
 * dependencies, so it runs in the default vitest 'node' environment.
 */

import { describe, it, expect } from 'vitest'
import {
  dedupeEscalations,
  escalationReasonLabel,
  type EscalationLike,
} from './escalation-dedupe.js'

function mk(
  id: string,
  task: string,
  reason: string | null,
  iso: string,
): EscalationLike {
  return {
    escalationId: id,
    taskId: task,
    reason,
    state: 'open',
    createdAt: iso,
  }
}

describe('dedupeEscalations', () => {
  it('returns empty list for empty input', () => {
    expect(dedupeEscalations([])).toEqual([])
  })

  it('keeps a single escalation as-is with duplicateCount=0', () => {
    const out = dedupeEscalations([
      mk('e1', 't1', 'retry_budget_exhausted', '2025-01-01T00:00:00.000Z'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.duplicateCount).toBe(0)
    expect(out[0]?.groupIds).toEqual(['e1'])
  })

  it('groups by composite (task_id, reason) and keeps the most recent as the head', () => {
    const out = dedupeEscalations([
      mk('e1', 't1', 'retry_budget_exhausted', '2025-01-01T00:00:00.000Z'),
      mk('e2', 't1', 'retry_budget_exhausted', '2025-01-02T00:00:00.000Z'),
      mk('e3', 't1', 'retry_budget_exhausted', '2025-01-03T00:00:00.000Z'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.escalationId).toBe('e3') // newest first
    expect(out[0]?.duplicateCount).toBe(2)
    expect(out[0]?.groupIds).toEqual(['e3', 'e2', 'e1'])
    expect(out[0]?.mostRecentIso).toBe('2025-01-03T00:00:00.000Z')
  })

  it('does NOT group across different reasons even on same task', () => {
    const out = dedupeEscalations([
      mk('e1', 't1', 'retry_budget_exhausted', '2025-01-01T00:00:00.000Z'),
      mk('e2', 't1', 'timeout_after_retries', '2025-01-02T00:00:00.000Z'),
    ])
    expect(out).toHaveLength(2)
  })

  it('does NOT group across different tasks even on same reason', () => {
    const out = dedupeEscalations([
      mk('e1', 't1', 'retry_budget_exhausted', '2025-01-01T00:00:00.000Z'),
      mk('e2', 't2', 'retry_budget_exhausted', '2025-01-02T00:00:00.000Z'),
    ])
    expect(out).toHaveLength(2)
  })

  it('treats null reason as a stable bucket (does not crash)', () => {
    const out = dedupeEscalations([
      mk('e1', 't1', null, '2025-01-01T00:00:00.000Z'),
      mk('e2', 't1', null, '2025-01-02T00:00:00.000Z'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]?.duplicateCount).toBe(1)
  })

  it('sorts the output groups by mostRecentIso DESC', () => {
    const out = dedupeEscalations([
      mk('a', 't1', 'r', '2025-01-01T00:00:00.000Z'),
      mk('b', 't2', 'r', '2025-01-05T00:00:00.000Z'),
      mk('c', 't3', 'r', '2025-01-03T00:00:00.000Z'),
    ])
    expect(out.map((g) => g.escalationId)).toEqual(['b', 'c', 'a'])
  })

  it('accepts Date instances for createdAt and normalizes to ISO', () => {
    const out = dedupeEscalations([
      {
        escalationId: 'e1',
        taskId: 't1',
        reason: 'retry_budget_exhausted',
        state: 'open',
        createdAt: new Date('2025-04-01T12:00:00.000Z'),
      },
    ])
    expect(out[0]?.mostRecentIso).toBe('2025-04-01T12:00:00.000Z')
  })
})

describe('escalationReasonLabel', () => {
  it('renders human-readable labels for known reasons', () => {
    expect(escalationReasonLabel('retry_budget_exhausted')).toBe('Retry budget exhausted')
    expect(escalationReasonLabel('timeout_after_retries')).toBe('Timed out after retries')
    expect(escalationReasonLabel('hook_rejected_critical')).toBe('Hook rejected (critical)')
  })

  it('falls back to "Escalation" for null/unknown reasons', () => {
    expect(escalationReasonLabel(null)).toBe('Escalation')
    expect(escalationReasonLabel(undefined)).toBe('Escalation')
    expect(escalationReasonLabel('not_a_real_reason')).toBe('Escalation')
  })
})
