/**
 * Unit tests for the NL ticket creator helpers.
 *
 * The codebase doesn't include @testing-library/react (no DOM environment is
 * configured for the UI package — see vitest.config.ts and the existing
 * KpiCards.test.tsx pattern). Component-level rendering is exercised via
 * Playwright (test/e2e/backlog.spec.ts). This file covers the pure helpers
 * the component delegates to: proposal-to-form mapping, validity, summary.
 *
 * Helpers exported by `nl-ticket-creator-helpers.ts`:
 *   - toEditableProposal(proposal, epics) — form state from a server Proposal
 *   - isProposalValid(draft) — submit-button gating
 *   - summarizeRationale(proposal) — "Create this?" hint copy
 *
 * The drawer-side helpers (buildMondayLink / readMondayItemId) live in
 * StoryDrawer.tsx and are exercised in this file too because they have
 * trivial coverage requirements and the file count is already large.
 */

import { describe, it, expect } from 'vitest'
import {
  toEditableProposal,
  isProposalValid,
  summarizeRationale,
  type ProposalLike,
  type EpicOption,
} from './nl-ticket-creator-helpers.js'
import { buildMondayLink, readMondayItemId } from './StoryDrawer.js'

const STORY_PROPOSAL: ProposalLike = {
  kind: 'story',
  title: 'Password reset via email',
  description: 'I want password reset via email\n\nCaptured as a user story.',
  ac_titles: [
    'User can request a password reset link with their email address',
    'Reset link is single-use and expires within 24 hours',
  ],
  suggested_epic_title: 'Authentication',
  priority: 100,
  story_points: 3,
  parser_engine: 'templated',
  rationale: ['story-language detected (^i (want|need|would like))'],
}

const BUG_PROPOSAL: ProposalLike = {
  kind: 'bug',
  title: 'Login is broken on Safari 17',
  description: 'Login is broken on Safari 17\n\nReported as a bug; severity medium.',
  ac_titles: [
    'The reported defect is reproducible from the user description',
    'A regression test covers the failing path',
    'The defect does not reproduce after the fix',
  ],
  suggested_epic_title: null,
  priority: 100,
  story_points: 2,
  persona_of_record: 'qa',
  bug: { defect_id: '01950000-0000-7000-8000-000000000001', severity: 'medium' },
  parser_engine: 'templated',
  rationale: ['bug-language detected (\\b(bug|broken|broke|crash...))'],
}

const EPIC_PROPOSAL: ProposalLike = {
  kind: 'epic',
  title: 'Notifications overhaul',
  description: 'Epic: notifications overhaul\n\nCaptured as an epic; decompose into stories.',
  ac_titles: [
    'The epic encompasses 3-7 related stories with clear acceptance',
    'Stories under the epic share a single user-facing outcome',
  ],
  suggested_epic_title: null,
  priority: 100,
  story_points: null,
  persona_of_record: 'pm',
  parser_engine: 'templated',
  rationale: ['epic-language detected'],
}

const EPICS: EpicOption[] = [
  { epicId: 'epic-auth', title: 'Authentication' },
  { epicId: 'epic-notif', title: 'Notifications' },
]

describe('toEditableProposal', () => {
  it('resolves the suggested epic title to its id', () => {
    const draft = toEditableProposal(STORY_PROPOSAL, EPICS)
    expect(draft.selected_epic_id).toBe('epic-auth')
    expect(draft.kind).toBe('story')
    expect(draft.title).toBe('Password reset via email')
  })

  it('falls back to the first available epic when no suggestion', () => {
    const draft = toEditableProposal(BUG_PROPOSAL, EPICS)
    expect(draft.selected_epic_id).toBe('epic-auth')
  })

  it('leaves selected_epic_id empty for kind=epic', () => {
    const draft = toEditableProposal(EPIC_PROPOSAL, EPICS)
    expect(draft.selected_epic_id).toBe('')
    expect(draft.kind).toBe('epic')
  })

  it('returns empty selected_epic_id when no epics exist', () => {
    const draft = toEditableProposal(STORY_PROPOSAL, [])
    expect(draft.selected_epic_id).toBe('')
  })

  it('clones the AC array (proposed list is not mutated by edits)', () => {
    const draft = toEditableProposal(STORY_PROPOSAL, EPICS)
    draft.ac_titles[0] = 'mutated'
    expect(STORY_PROPOSAL.ac_titles[0]).not.toBe('mutated')
  })
})

describe('isProposalValid', () => {
  it('valid story passes', () => {
    const draft = toEditableProposal(STORY_PROPOSAL, EPICS)
    expect(isProposalValid(draft)).toBe(true)
  })

  it('story without an epic fails', () => {
    const draft = toEditableProposal(STORY_PROPOSAL, [])
    expect(isProposalValid(draft)).toBe(false)
  })

  it('story without a title fails', () => {
    const draft = toEditableProposal(STORY_PROPOSAL, EPICS)
    draft.title = '   '
    expect(isProposalValid(draft)).toBe(false)
  })

  it('story without any AC fails', () => {
    const draft = toEditableProposal(STORY_PROPOSAL, EPICS)
    draft.ac_titles = ['', '   ']
    expect(isProposalValid(draft)).toBe(false)
  })

  it('story without a description fails', () => {
    const draft = toEditableProposal(STORY_PROPOSAL, EPICS)
    draft.description = ''
    expect(isProposalValid(draft)).toBe(false)
  })

  it('valid bug passes', () => {
    const draft = toEditableProposal(BUG_PROPOSAL, EPICS)
    expect(isProposalValid(draft)).toBe(true)
  })

  it('valid epic passes (no epic-id required, no AC required)', () => {
    const draft = toEditableProposal(EPIC_PROPOSAL, EPICS)
    expect(isProposalValid(draft)).toBe(true)
  })

  it('epic without rationale fails', () => {
    const draft = toEditableProposal(EPIC_PROPOSAL, EPICS)
    draft.description = '   '
    expect(isProposalValid(draft)).toBe(false)
  })
})

describe('summarizeRationale', () => {
  it('produces a non-empty summary for a story', () => {
    const s = summarizeRationale(STORY_PROPOSAL)
    expect(s.length).toBeGreaterThan(0)
    expect(s.charAt(0)).toBe(s.charAt(0).toUpperCase())
  })

  it('strips engine= and forceKind= internal labels', () => {
    const fake: ProposalLike = {
      ...STORY_PROPOSAL,
      rationale: ['engine=anthropic/claude-haiku-4-5', 'forceKind=story (UI override)'],
    }
    const s = summarizeRationale(fake)
    expect(s).toMatch(/Classified as a story/i)
  })

  it('falls back to a default when rationale is empty', () => {
    const fake: ProposalLike = { ...BUG_PROPOSAL, rationale: [] }
    expect(summarizeRationale(fake)).toMatch(/bug/i)
  })
})

describe('buildMondayLink', () => {
  it('returns null when boardId is null', () => {
    expect(buildMondayLink(null, 'item-1')).toBeNull()
  })

  it('returns null when itemId is empty', () => {
    expect(buildMondayLink('board-1', '')).toBeNull()
  })

  it('returns a deep link when both are present', () => {
    expect(buildMondayLink('123', '456')).toBe('https://monday.com/boards/123/pulses/456')
  })
})

describe('readMondayItemId', () => {
  it('returns null on null row', () => {
    expect(readMondayItemId(null)).toBeNull()
  })

  it('reads camelCase mondayItemId', () => {
    expect(readMondayItemId({ mondayItemId: 'abc' })).toBe('abc')
  })

  it('reads snake_case monday_item_id', () => {
    expect(readMondayItemId({ monday_item_id: 'def' })).toBe('def')
  })

  it('returns null on empty string', () => {
    expect(readMondayItemId({ mondayItemId: '' })).toBeNull()
  })

  it('returns null on non-string', () => {
    expect(readMondayItemId({ mondayItemId: 12345 })).toBeNull()
  })
})
