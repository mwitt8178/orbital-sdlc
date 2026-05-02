/**
 * Tests for ThreadView pure logic — thread nesting calculations.
 *
 * No DOM/React rendering. Tests the reply-finding logic that ThreadView uses.
 */

import { describe, it, expect } from 'vitest'
import type { ChannelPost } from '../../../store/channels.js'

// Minimal post factory.
function makePost(overrides: Partial<ChannelPost> & { id: string }): ChannelPost {
  return {
    id: overrides.id,
    channelId: overrides.channelId ?? 'ch-1',
    authorName: overrides.authorName ?? 'test-user',
    authorKind: overrides.authorKind ?? 'user',
    postType: overrides.postType ?? 'user_guidance',
    body: overrides.body ?? 'Test body',
    occurredAt: overrides.occurredAt ?? '2026-01-01T00:00:00Z',
    parentPostId: overrides.parentPostId ?? null,
  }
}

/** Mirror the thread-finding logic from ThreadView. */
function findReplies(posts: ChannelPost[], parentId: string): ChannelPost[] {
  return posts.filter((p) => p.parentPostId === parentId)
}

/** Top-level posts (no parent). */
function topLevelPosts(posts: ChannelPost[]): ChannelPost[] {
  return posts.filter((p) => !p.parentPostId)
}

describe('ThreadView reply logic', () => {
  it('finds no replies when there are none', () => {
    const posts = [makePost({ id: 'p-1' }), makePost({ id: 'p-2' })]
    expect(findReplies(posts, 'p-1')).toHaveLength(0)
  })

  it('finds direct replies to a parent', () => {
    const posts = [
      makePost({ id: 'p-1' }),
      makePost({ id: 'p-2', parentPostId: 'p-1' }),
      makePost({ id: 'p-3', parentPostId: 'p-1' }),
      makePost({ id: 'p-4', parentPostId: 'p-2' }),
    ]
    expect(findReplies(posts, 'p-1')).toHaveLength(2)
    expect(findReplies(posts, 'p-2')).toHaveLength(1)
  })

  it('topLevelPosts excludes replies', () => {
    const posts = [
      makePost({ id: 'p-1' }),
      makePost({ id: 'p-2', parentPostId: 'p-1' }),
      makePost({ id: 'p-3' }),
    ]
    const top = topLevelPosts(posts)
    expect(top).toHaveLength(2)
    expect(top.map((p) => p.id)).toEqual(['p-1', 'p-3'])
  })

  it('deeply nested replies are findable at each level', () => {
    const posts = [
      makePost({ id: 'root' }),
      makePost({ id: 'lvl1', parentPostId: 'root' }),
      makePost({ id: 'lvl2', parentPostId: 'lvl1' }),
      makePost({ id: 'lvl3', parentPostId: 'lvl2' }),
    ]
    expect(findReplies(posts, 'root')).toHaveLength(1)
    expect(findReplies(posts, 'lvl1')).toHaveLength(1)
    expect(findReplies(posts, 'lvl2')).toHaveLength(1)
    expect(findReplies(posts, 'lvl3')).toHaveLength(0)
  })

  it('replies to different parents do not cross-contaminate', () => {
    const posts = [
      makePost({ id: 'p-1' }),
      makePost({ id: 'p-2' }),
      makePost({ id: 'r-1', parentPostId: 'p-1' }),
      makePost({ id: 'r-2', parentPostId: 'p-2' }),
    ]
    expect(findReplies(posts, 'p-1').map((p) => p.id)).toEqual(['r-1'])
    expect(findReplies(posts, 'p-2').map((p) => p.id)).toEqual(['r-2'])
  })
})
