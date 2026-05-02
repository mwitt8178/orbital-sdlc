/**
 * Unit tests for vision/epic-suggester.ts
 *
 * Per architecture.md test plan:
 *   - keyword matching across title, summary, and goals
 *   - ordering: longest-keyword wins; first match per template wins
 *   - max 5 epics returned
 *   - generic fallback when no keywords match
 *   - empty / minimal vision degenerate case
 *   - story title generation per epic (2-4 stories)
 *
 * The suggester is deterministic (no LLM in v1) so all assertions are exact.
 */

import { describe, it, expect } from 'vitest'
import { suggestEpicsFromVision } from '../../../src/vision/epic-suggester.js'

// ---------------------------------------------------------------------------
// Helper: build a minimal vision content object suitable for suggestion input
// ---------------------------------------------------------------------------

interface VisionContentInput {
  title: string
  summary: string
  goals?: Array<{ id: string; text: string; rank: number }>
}

function makeContent(input: VisionContentInput): Record<string, unknown> {
  return {
    schema_version: 1,
    title: input.title,
    summary: input.summary,
    goals: (input.goals ?? []).map((g, i) => ({ id: g.id ?? `g${i}`, text: g.text, rank: g.rank ?? i })),
    non_goals: [],
    target_users: [],
    acceptance_criteria: [],
    glossary: [],
    edge_cases: [],
    open_questions: [],
    assumptions_log: [],
    metadata: {
      pm_persona_id: 'pm-stub',
      model_used: 'stub',
      intake_started_at: new Date().toISOString(),
      intake_token_total: 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Keyword-driven suggestion tests
// ---------------------------------------------------------------------------

describe('suggestEpicsFromVision — keyword matching', () => {
  it('billing keyword surfaces Subscription/Billing epics', () => {
    const content = makeContent({
      title: 'Acme Billing',
      summary: 'Customer-facing recurring billing platform with self-serve checkout.',
    })
    const result = suggestEpicsFromVision(content)
    expect(result.epics.length).toBeGreaterThan(0)
    const titles = result.epics.map((e) => e.title.toLowerCase())
    expect(titles.some((t) => t.includes('billing') || t.includes('subscription') || t.includes('invoic'))).toBe(true)
  })

  it('auth keyword surfaces Authentication epic', () => {
    const content = makeContent({
      title: 'TeamHub',
      summary: 'A workspace where users can sign up, log in, and manage their account.',
    })
    const result = suggestEpicsFromVision(content)
    const titles = result.epics.map((e) => e.title.toLowerCase())
    expect(titles.some((t) => t.includes('auth') || t.includes('account'))).toBe(true)
  })

  it('dashboard keyword surfaces Reporting epic', () => {
    const content = makeContent({
      title: 'Insights',
      summary: 'A dashboard that shows analytics and key business metrics over time.',
    })
    const result = suggestEpicsFromVision(content)
    const titles = result.epics.map((e) => e.title.toLowerCase())
    expect(titles.some((t) => t.includes('dashboard') || t.includes('report') || t.includes('metric'))).toBe(true)
  })

  it('combines keywords from title + summary + goals', () => {
    const content = makeContent({
      title: 'TaskFlow',
      summary: 'A task management tool.',
      goals: [
        { id: 'g1', text: 'Real-time chat between teammates', rank: 0 },
        { id: 'g2', text: 'File upload and storage', rank: 1 },
      ],
    })
    const result = suggestEpicsFromVision(content)
    // Should pull from at least 2 distinct categories: task + chat or task + file
    const titles = result.epics.map((e) => e.title.toLowerCase())
    const hasTask = titles.some((t) => t.includes('task') || t.includes('workflow'))
    const hasChatOrFile = titles.some((t) => t.includes('chat') || t.includes('message') || t.includes('file') || t.includes('upload'))
    expect(hasTask).toBe(true)
    expect(hasChatOrFile).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Generic fallback
// ---------------------------------------------------------------------------

describe('suggestEpicsFromVision — generic fallback', () => {
  it('returns three generic epics when no keywords match', () => {
    const content = makeContent({
      title: 'Mystery',
      summary: 'something completely opaque with zero recognizable terms zzzqqq.',
    })
    const result = suggestEpicsFromVision(content)
    expect(result.epics).toHaveLength(3)
    const titles = result.epics.map((e) => e.title)
    expect(titles).toContain('Core experience')
    expect(titles).toContain('Account management')
    expect(titles).toContain('Reporting')
  })

  it('handles empty title and summary without crashing', () => {
    const content = makeContent({ title: '', summary: '' })
    const result = suggestEpicsFromVision(content)
    expect(result.epics.length).toBeGreaterThanOrEqual(3)
    expect(result.epics[0]).toHaveProperty('title')
    expect(result.epics[0]).toHaveProperty('description')
    expect(result.epics[0]).toHaveProperty('story_titles')
  })
})

// ---------------------------------------------------------------------------
// Cap and ordering rules
// ---------------------------------------------------------------------------

describe('suggestEpicsFromVision — cap and ordering', () => {
  it('caps at 5 epics regardless of keyword density', () => {
    // Stuff every keyword into the summary
    const content = makeContent({
      title: 'Mega',
      summary:
        'billing subscription invoice auth login signup dashboard report task workflow chat message file upload calendar schedule search filter team member ai gpt',
    })
    const result = suggestEpicsFromVision(content)
    expect(result.epics.length).toBeLessThanOrEqual(5)
  })

  it('returns at least 3 epics when at least one keyword matches', () => {
    const content = makeContent({
      title: 'Acme Auth',
      summary: 'A login and signup flow.',
    })
    const result = suggestEpicsFromVision(content)
    expect(result.epics.length).toBeGreaterThanOrEqual(3)
  })

  it('does not duplicate epics when same keyword appears multiple times', () => {
    const content = makeContent({
      title: 'Billing Billing Billing',
      summary: 'billing subscription billing invoice billing',
    })
    const result = suggestEpicsFromVision(content)
    const titles = result.epics.map((e) => e.title)
    const uniqueTitles = new Set(titles)
    expect(uniqueTitles.size).toBe(titles.length)
  })
})

// ---------------------------------------------------------------------------
// Story title shape
// ---------------------------------------------------------------------------

describe('suggestEpicsFromVision — story titles', () => {
  it('every epic has 2-4 story titles', () => {
    const content = makeContent({
      title: 'Acme Billing',
      summary: 'subscription billing platform',
    })
    const result = suggestEpicsFromVision(content)
    for (const epic of result.epics) {
      expect(epic.story_titles.length).toBeGreaterThanOrEqual(2)
      expect(epic.story_titles.length).toBeLessThanOrEqual(4)
      for (const story of epic.story_titles) {
        expect(typeof story).toBe('string')
        expect(story.length).toBeGreaterThan(0)
      }
    }
  })

  it('every epic has non-empty title and description', () => {
    const content = makeContent({
      title: 'Acme Auth',
      summary: 'login and signup',
    })
    const result = suggestEpicsFromVision(content)
    for (const epic of result.epics) {
      expect(epic.title.length).toBeGreaterThan(0)
      expect(epic.description.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// Determinism
// ---------------------------------------------------------------------------

describe('suggestEpicsFromVision — determinism', () => {
  it('returns the same suggestions for the same input', () => {
    const content = makeContent({
      title: 'TaskFlow',
      summary: 'A task management tool with chat',
    })
    const a = suggestEpicsFromVision(content)
    const b = suggestEpicsFromVision(content)
    expect(a.epics.map((e) => e.title)).toEqual(b.epics.map((e) => e.title))
  })
})
