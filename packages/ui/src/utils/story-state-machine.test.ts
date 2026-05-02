import { describe, it, expect } from 'vitest'
import {
  getValidNextStatuses,
  isValidStoryTransition,
  transitionRequiresLinkedArtifact,
  statusBadgeColor,
  statusLabel,
} from './story-state-machine.js'

describe('getValidNextStatuses', () => {
  it('includes the current status first', () => {
    expect(getValidNextStatuses('backlog')[0]).toBe('backlog')
    expect(getValidNextStatuses('done')[0]).toBe('done')
  })

  it('returns canonical next states for backlog', () => {
    expect(getValidNextStatuses('backlog')).toEqual(['backlog', 'ready'])
  })

  it('returns canonical next states for done', () => {
    expect(getValidNextStatuses('done')).toEqual(['done', 'accepted', 'defective'])
  })

  it('terminal states only include themselves', () => {
    expect(getValidNextStatuses('accepted')).toEqual(['accepted'])
    expect(getValidNextStatuses('cancelled')).toEqual(['cancelled'])
  })

  it('blocked can return to in_progress or ready', () => {
    expect(getValidNextStatuses('blocked')).toEqual(['blocked', 'in_progress', 'ready'])
  })

  it('defective can return to backlog', () => {
    expect(getValidNextStatuses('defective')).toEqual(['defective', 'backlog'])
  })
})

describe('isValidStoryTransition', () => {
  it('allows identity', () => {
    expect(isValidStoryTransition('backlog', 'backlog')).toBe(true)
  })

  it('allows backlog -> ready', () => {
    expect(isValidStoryTransition('backlog', 'ready')).toBe(true)
  })

  it('rejects backlog -> done', () => {
    expect(isValidStoryTransition('backlog', 'done')).toBe(false)
  })

  it('rejects accepted -> anything', () => {
    expect(isValidStoryTransition('accepted', 'backlog')).toBe(false)
  })
})

describe('transitionRequiresLinkedArtifact', () => {
  it('in_review -> done requires pr or commit', () => {
    expect(transitionRequiresLinkedArtifact('in_review', 'done')).toEqual(['pr', 'commit'])
  })

  it('done -> accepted requires uat_result', () => {
    expect(transitionRequiresLinkedArtifact('done', 'accepted')).toEqual(['uat_result'])
  })

  it('done -> defective requires defect or failed_ac_id', () => {
    expect(transitionRequiresLinkedArtifact('done', 'defective')).toEqual([
      'defect',
      'failed_ac_id',
    ])
  })

  it('returns null for transitions that do not require artifacts', () => {
    expect(transitionRequiresLinkedArtifact('backlog', 'ready')).toBeNull()
    expect(transitionRequiresLinkedArtifact('ready', 'in_progress')).toBeNull()
  })
})

describe('statusBadgeColor', () => {
  it('returns a color for every valid status', () => {
    const statuses = [
      'backlog',
      'ready',
      'in_progress',
      'in_review',
      'done',
      'accepted',
      'blocked',
      'defective',
      'cancelled',
    ] as const
    for (const s of statuses) {
      expect(statusBadgeColor(s)).toMatch(/^(slate|amber|blue|indigo|emerald|rose|violet)$/)
    }
  })
})

describe('statusLabel', () => {
  it('formats snake_case statuses into title case', () => {
    expect(statusLabel('in_progress')).toBe('In progress')
    expect(statusLabel('in_review')).toBe('In review')
  })
  it('capitalises single-word statuses', () => {
    expect(statusLabel('backlog')).toBe('Backlog')
    expect(statusLabel('accepted')).toBe('Accepted')
  })
})
