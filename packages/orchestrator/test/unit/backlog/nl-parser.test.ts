/**
 * Unit tests for the NL ticket parser (templated mode).
 *
 * The Anthropic-backed engine is exercised via the integration test
 * (`test/integration/backlog/nl-parse-and-create.integration.test.ts`); this
 * file covers the templated rules that ship as the default offline path.
 *
 * Goals:
 *   - Bug language → kind=bug + defect_id + severity classifier
 *   - Story language ("I want…", "as a user…") → kind=story
 *   - Epic language ("epic", "theme", "milestone") → kind=epic
 *   - Default fallback → kind=story when no rule matches
 *   - forceKind override always wins
 *   - Title extraction strips filler verbs and trailing punctuation
 *   - AC extraction picks tailored ACs for known action verbs
 *   - Epic suggestion uses token-overlap and ignores stop words
 *   - Severity classifier covers low/medium/high/critical
 */

import { describe, it, expect } from 'vitest'
import {
  parseTemplated,
  extractTitle,
  extractAcceptanceCriteria,
  suggestEpic,
  type VisionContextSummary,
} from '../../../src/backlog/nl-parser.js'

const EMPTY_VISION: VisionContextSummary = {
  title: '',
  summary: '',
  topGoals: [],
  existingEpicTitles: [],
}

const VISION_WITH_EPICS: VisionContextSummary = {
  title: 'Auth product',
  summary: 'Self-serve identity for SaaS',
  topGoals: ['Frictionless signup', 'Recover lost passwords', 'SSO with Google'],
  existingEpicTitles: ['Authentication', 'User profile', 'Notifications'],
}

describe('parseTemplated — bug classification', () => {
  it('classifies "login is broken" as a bug', () => {
    const p = parseTemplated('Login is broken on mobile Safari', EMPTY_VISION)
    expect(p.kind).toBe('bug')
    expect(p.bug?.defect_id).toMatch(/^[0-9a-f-]{36}$/)
    expect(p.persona_of_record).toBe('qa')
  })

  it('classifies "the export button doesn\'t work" as a bug', () => {
    const p = parseTemplated("The export button doesn't work after the latest deploy", EMPTY_VISION)
    expect(p.kind).toBe('bug')
  })

  it('classifies a crash as a bug', () => {
    const p = parseTemplated('App crashes when uploading a file larger than 10mb', EMPTY_VISION)
    expect(p.kind).toBe('bug')
  })

  it('classifies a stack trace as a bug', () => {
    const p = parseTemplated('Got a 500 error returning from the dashboard', EMPTY_VISION)
    expect(p.kind).toBe('bug')
  })

  it('classifies "blank screen" as a bug', () => {
    const p = parseTemplated('Users see a blank screen after login', EMPTY_VISION)
    expect(p.kind).toBe('bug')
  })

  it('returns three bug-flavoured ACs', () => {
    const p = parseTemplated('Login button does nothing on Firefox', EMPTY_VISION)
    expect(p.kind).toBe('bug')
    expect(p.ac_titles).toHaveLength(3)
    expect(p.ac_titles[0]).toMatch(/reproducib/i)
    expect(p.ac_titles[2]).toMatch(/not reproduce/i)
  })
})

describe('parseTemplated — bug severity', () => {
  it('marks a critical-language bug as severity=critical with priority 0', () => {
    const p = parseTemplated('Production is down — every user gets a 500 on /api/auth', EMPTY_VISION)
    expect(p.kind).toBe('bug')
    expect(p.bug?.severity).toBe('critical')
    expect(p.priority).toBe(0)
  })

  it('marks a high-severity bug with priority 10', () => {
    const p = parseTemplated('High severity: payment crashes every time on checkout', EMPTY_VISION)
    expect(p.bug?.severity).toBe('high')
    expect(p.priority).toBe(10)
  })

  it('marks a low-severity cosmetic bug with priority 200', () => {
    const p = parseTemplated('Minor typo on the settings page header', EMPTY_VISION)
    expect(p.bug?.severity).toBe('low')
    expect(p.priority).toBe(200)
  })

  it('defaults to medium severity for unmarked bugs', () => {
    const p = parseTemplated('Login button does nothing on Safari 17', EMPTY_VISION)
    expect(p.bug?.severity).toBe('medium')
    expect(p.priority).toBe(100)
  })
})

describe('parseTemplated — story classification', () => {
  it('classifies "I want password reset via email" as a story', () => {
    const p = parseTemplated('I want password reset via email', VISION_WITH_EPICS)
    expect(p.kind).toBe('story')
    expect(p.title).toBe('Password reset via email')
    expect(p.persona_of_record).toBeUndefined()
  })

  it('classifies "as a user, I want to sign in" as a story', () => {
    const p = parseTemplated('As a user, I want to sign in with my email', EMPTY_VISION)
    expect(p.kind).toBe('story')
  })

  it('classifies "implement search" as a story', () => {
    const p = parseTemplated('Implement search across the dashboard', EMPTY_VISION)
    expect(p.kind).toBe('story')
  })

  it('classifies "add a profile picture" as a story', () => {
    const p = parseTemplated('Add a profile picture to the user settings', EMPTY_VISION)
    expect(p.kind).toBe('story')
  })

  it('extracts password-reset specific ACs', () => {
    const p = parseTemplated('I want password reset via email', EMPTY_VISION)
    expect(p.ac_titles[0]).toMatch(/password reset link/i)
    expect(p.ac_titles[1]).toMatch(/single-use|expires/i)
    expect(p.ac_titles[2]).toMatch(/new password/i)
  })

  it('extracts login-specific ACs', () => {
    const p = parseTemplated('Add login with email and password', EMPTY_VISION)
    expect(p.ac_titles[0]).toMatch(/sign in|valid credentials/i)
  })

  it('falls back to generic ACs when no verb matches', () => {
    const p = parseTemplated('Make the dashboard nicer', EMPTY_VISION)
    expect(p.ac_titles).toHaveLength(2)
    expect(p.ac_titles[0]).toMatch(/end-to-end|behaviour/i)
  })

  it('defaults story_points to 3 for stories', () => {
    const p = parseTemplated('I want a way to invite teammates', EMPTY_VISION)
    expect(p.story_points).toBe(3)
  })
})

describe('parseTemplated — epic classification', () => {
  it('classifies "Epic: notifications overhaul" as an epic', () => {
    const p = parseTemplated('Epic: notifications overhaul', EMPTY_VISION)
    expect(p.kind).toBe('epic')
    expect(p.persona_of_record).toBe('pm')
    expect(p.story_points).toBeNull()
  })

  it('classifies "milestone for SSO support" as an epic', () => {
    const p = parseTemplated('Milestone for SSO support across all enterprise plans', EMPTY_VISION)
    expect(p.kind).toBe('epic')
  })

  it('classifies "theme around onboarding" as an epic', () => {
    const p = parseTemplated('Theme around new user onboarding', EMPTY_VISION)
    expect(p.kind).toBe('epic')
  })

  it('does NOT suggest an epic for a kind=epic proposal', () => {
    const p = parseTemplated('Epic: rebuild authentication', VISION_WITH_EPICS)
    expect(p.kind).toBe('epic')
    expect(p.suggested_epic_title).toBeNull()
  })

  it('returns 2 epic-flavoured ACs', () => {
    const p = parseTemplated('Epic: notifications overhaul', EMPTY_VISION)
    expect(p.ac_titles).toHaveLength(2)
    expect(p.ac_titles[0]).toMatch(/encompasses|stories/i)
  })
})

describe('parseTemplated — fallback', () => {
  it('defaults to kind=story when no rule matches', () => {
    const p = parseTemplated('something something dashboard', EMPTY_VISION)
    expect(p.kind).toBe('story')
    expect(p.rationale).toContain('default kind=story (no rule matched)')
  })

  it('throws on empty prompt', () => {
    expect(() => parseTemplated('', EMPTY_VISION)).toThrow(/empty/i)
    expect(() => parseTemplated('   ', EMPTY_VISION)).toThrow(/empty/i)
  })
})

describe('parseTemplated — forceKind override', () => {
  it('forceKind=bug wins over story-language', () => {
    const p = parseTemplated('I want password reset', EMPTY_VISION, { forceKind: 'bug' })
    expect(p.kind).toBe('bug')
    expect(p.bug?.defect_id).toBeTruthy()
  })

  it('forceKind=epic wins over bug-language', () => {
    const p = parseTemplated('Login is broken across all browsers', EMPTY_VISION, {
      forceKind: 'epic',
    })
    expect(p.kind).toBe('epic')
  })

  it('forceKind=story wins over epic-language', () => {
    const p = parseTemplated('Epic: rebuild auth flow', EMPTY_VISION, { forceKind: 'story' })
    expect(p.kind).toBe('story')
  })
})

describe('parseTemplated — engine label', () => {
  it('marks the engine as templated', () => {
    const p = parseTemplated('I want password reset', EMPTY_VISION)
    expect(p.parser_engine).toBe('templated')
  })
})

describe('parseTemplated — description', () => {
  it('preserves the verbatim prompt in description', () => {
    const prompt = 'I want password reset via email so I can recover my account'
    const p = parseTemplated(prompt, EMPTY_VISION)
    expect(p.description.startsWith(prompt)).toBe(true)
  })

  it('appends a clarification line for stories', () => {
    const p = parseTemplated('I want password reset via email', EMPTY_VISION)
    expect(p.description).toMatch(/user story/i)
  })

  it('appends a severity-bearing clarification for bugs', () => {
    const p = parseTemplated('Login is broken on Safari', EMPTY_VISION)
    expect(p.description).toMatch(/severity medium/i)
  })
})

describe('parseTemplated — epic suggestion', () => {
  it('suggests an existing epic when token-overlap is present', () => {
    const p = parseTemplated(
      'I want password reset via email for authentication users',
      VISION_WITH_EPICS,
    )
    expect(p.suggested_epic_title).toBe('Authentication')
  })

  it('returns null when no overlap', () => {
    const p = parseTemplated('I want a totally unrelated feature', VISION_WITH_EPICS)
    expect(p.suggested_epic_title).toBeNull()
  })

  it('returns null when there are no epics', () => {
    const p = parseTemplated('I want password reset via email', EMPTY_VISION)
    expect(p.suggested_epic_title).toBeNull()
  })
})

describe('extractTitle', () => {
  it('uses the first 6-8 words and strips trailing punctuation', () => {
    expect(extractTitle('I want password reset via email.', 'story')).toBe(
      'Password reset via email',
    )
  })

  it('strips "as a user, I want"', () => {
    expect(
      extractTitle('As a user, I want to invite my teammates to the workspace', 'story'),
    ).toBe('Invite my teammates to the workspace')
  })

  it('strips a leading "please"', () => {
    expect(extractTitle('Please add a CSV export', 'story')).toBe('Add a CSV export')
  })

  it('falls back to "New {kind}" on an empty cleaned prompt', () => {
    expect(extractTitle('I want', 'story')).toMatch(/New story|to/i)
  })

  it('caps the title at 8 words', () => {
    const title = extractTitle('Add a profile photo upload to the user settings page', 'story')
    expect(title.split(' ').length).toBeLessThanOrEqual(8)
  })
})

describe('extractAcceptanceCriteria', () => {
  it('returns 3 bug ACs for kind=bug', () => {
    const acs = extractAcceptanceCriteria('login broken', 'bug', {
      defect_id: '00000000-0000-0000-0000-000000000001',
      severity: 'medium',
    })
    expect(acs).toHaveLength(3)
  })

  it('returns 2 epic ACs for kind=epic', () => {
    const acs = extractAcceptanceCriteria('Epic: notifications', 'epic', undefined)
    expect(acs).toHaveLength(2)
  })

  it('returns at most 3 story ACs', () => {
    const acs = extractAcceptanceCriteria('I want password reset', 'story', undefined)
    expect(acs.length).toBeLessThanOrEqual(3)
  })

  it('returns search-specific ACs for search prompts', () => {
    const acs = extractAcceptanceCriteria('Add search to the dashboard', 'story', undefined)
    expect(acs[0]).toMatch(/search|filter/i)
  })

  it('returns export-specific ACs', () => {
    const acs = extractAcceptanceCriteria('export users as CSV', 'story', undefined)
    expect(acs[0]).toMatch(/export/i)
  })

  it('returns notification-specific ACs', () => {
    const acs = extractAcceptanceCriteria('send email notifications when a sprint completes', 'story', undefined)
    expect(acs[0]).toMatch(/notification|delivered/i)
  })
})

describe('suggestEpic', () => {
  it('returns null with no epics', () => {
    expect(suggestEpic('login feature', [])).toBeNull()
  })

  it('returns the best-overlapping title', () => {
    expect(suggestEpic('I want password reset for authentication', ['Authentication', 'Onboarding'])).toBe(
      'Authentication',
    )
  })

  it('ignores stop words when scoring overlap', () => {
    expect(suggestEpic('I want the the the auth', ['Authentication'])).toBe('Authentication')
  })

  it('returns null when no meaningful word overlap', () => {
    expect(suggestEpic('xyzzy quux', ['Authentication', 'Profile'])).toBeNull()
  })

  it('prefers the highest-overlap title', () => {
    expect(
      suggestEpic('user profile picture upload', ['Authentication', 'User profile picture']),
    ).toBe('User profile picture')
  })
})
