/**
 * commit-message.test.ts — Conventional Commit construction.
 *
 * [Engineer-Principal · Opus · run-story-pr-pipeline]
 */

import { describe, it, expect } from 'vitest'
import { buildBranchName, buildCommitMessage, shortId, slugifyTitle } from './commit-message.js'

describe('shortId', () => {
  it('strips dashes and takes first 8 chars', () => {
    expect(shortId('01234567-89ab-cdef-0123-456789abcdef')).toBe('01234567')
  })
})

describe('slugifyTitle', () => {
  it('lowercases and dasherises', () => {
    expect(slugifyTitle('Add User Profile Page')).toBe('add-user-profile-page')
  })
  it('strips leading/trailing dashes', () => {
    expect(slugifyTitle('  Hello, World!  ')).toBe('hello-world')
  })
  it('caps length', () => {
    const out = slugifyTitle('a'.repeat(200), 20)
    expect(out.length).toBeLessThanOrEqual(20)
  })
  it('falls back to "story" when empty', () => {
    expect(slugifyTitle('!!!')).toBe('story')
  })
})

describe('buildBranchName', () => {
  it('namespaces under orbital/story-', () => {
    expect(buildBranchName('11111111-2222-3333-4444-555555555555')).toBe('orbital/story-11111111')
  })
})

describe('buildCommitMessage', () => {
  it('produces a Conventional Commit subject and trailers', () => {
    const msg = buildCommitMessage({
      storyId: '11111111-2222-3333-4444-555555555555',
      title: 'Add user profile page',
    })
    expect(msg.split('\n')[0]).toBe('feat(story-11111111): Add user profile page')
    expect(msg).toContain('Closes story 11111111-2222-3333-4444-555555555555')
    expect(msg).toContain('Co-Authored-By: Orbital <noreply@orbital.local>')
  })
  it('includes the redirect note when present', () => {
    const msg = buildCommitMessage({
      storyId: '11111111-2222-3333-4444-555555555555',
      title: 'Add page',
      redirectNote: 'fix the radio buttons',
    })
    expect(msg).toContain('Reviewer redirect:')
    expect(msg).toContain('fix the radio buttons')
  })
  it('skips redirect block when blank', () => {
    const msg = buildCommitMessage({
      storyId: '11111111-2222-3333-4444-555555555555',
      title: 'Add page',
      redirectNote: '   ',
    })
    expect(msg).not.toContain('Reviewer redirect:')
  })
})
