/**
 * categories.test.ts — billing category mapping.
 *
 * [Engineer-Principal · Opus · run-settings-billing]
 */

import { describe, it, expect } from 'vitest'
import { categorize } from './categories.js'

describe('categorize', () => {
  it.each([
    ['sr-dev',         'story-execution'],
    ['jr-dev',         'story-execution'],
    ['engineer-sr',    'story-execution'],
    ['coding-agent',   'story-execution'],
    ['principal-dev',  'planning'],
    ['product',        'planning'],
    ['planner',        'planning'],
    ['reviewer',       'code-review'],
    ['verifier',       'code-review'],
    ['qa',             'code-review'],
    ['security',       'code-review'],
  ])('maps %s → %s', (persona, category) => {
    expect(categorize({ personaId: persona, taskId: null })).toBe(category)
  })

  it('treats untagged rows with a task as story-execution', () => {
    expect(categorize({ personaId: null, taskId: 'task-123' })).toBe('story-execution')
  })

  it('treats untagged rows without a task as other', () => {
    expect(categorize({ personaId: null, taskId: null })).toBe('other')
  })

  it('is case insensitive on persona id', () => {
    expect(categorize({ personaId: 'REVIEWER', taskId: null })).toBe('code-review')
  })

  it('falls through unknown personas to other', () => {
    expect(categorize({ personaId: 'unknown-persona', taskId: null })).toBe('other')
  })
})
