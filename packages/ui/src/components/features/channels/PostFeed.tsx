/**
 * PostFeed — paginated channel post list, hydrated from
 * channel.posts.read and merged with WS-streamed live posts.
 *
 * Strategy: tRPC fetch returns the most recent N posts (DESC by created_at).
 * Live posts arriving via WS are appended to the channel store; the feed
 * renders the union sorted ascending so the newest are at the bottom.
 *
 * Threading: top-level posts render with ThreadView. Posts with a
 * parent_post_id are NOT rendered at the top level — they only appear
 * inside the ThreadView of their parent.
 *
 * Disagreement banner: rendered above the feed when there are active
 * disagreements for this channel.
 */

import { useEffect, useMemo } from 'react'
import { trpc } from '../../../services/trpc.js'
import { useChannelsStore, type ChannelPost } from '../../../store/channels.js'
import { useDisagreementsStore } from '../../../store/disagreements.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { PostItem } from './PostItem.js'

interface PostFeedProps {
  channelId: string
}

export function PostFeed({ channelId }: PostFeedProps) {
  const setPosts = useChannelsStore((s) => s.setPosts)
  const liveByChannel = useChannelsStore((s) => s.posts[channelId] ?? [])
  const activeDisagreements = useDisagreementsStore((s) =>
    s.active.filter((d) => d.channelId === channelId && d.status !== 'resolved'),
  )

  const query = trpc.channel.posts.read.useQuery(
    { channel_id: channelId, limit: 100 },
    { staleTime: 5_000 },
  )

  useEffect(() => {
    if (!query.data) return
    const mapped: ChannelPost[] = query.data.items.map((row) => ({
      id: row.post_id,
      channelId: row.channel_id,
      authorName: extractAuthorName(row.author_actor),
      authorKind: extractAuthorKind(row.author_actor),
      postType: row.post_type as ChannelPost['postType'],
      body: extractBody(row.payload),
      occurredAt: row.created_at,
      parentPostId: row.parent_post_id ?? null,
    }))
    // Server returns DESC; we store ASC for natural top-down rendering.
    setPosts(channelId, mapped.reverse())
    // setPosts is a stable Zustand action; only re-run on upstream change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query.data, channelId])

  // Render union of stored posts (initial fetch + WS appends).
  const sorted = useMemo(
    () => [...liveByChannel].sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1)),
    [liveByChannel],
  )

  // Top-level posts only (no parent_post_id). Replies render inside ThreadView.
  const topLevelPosts = useMemo(
    () => sorted.filter((p) => !p.parentPostId),
    [sorted],
  )

  if (query.isLoading) {
    return (
      <div className="scrollbar-thin flex-1 space-y-3 overflow-y-auto px-5 py-4">
        <Skeleton rows={5} />
      </div>
    )
  }

  if (query.error) {
    return (
      <div className="flex flex-1 items-center justify-center px-5 py-4">
        <ErrorMessage title="Could not load posts" message={query.error.message} />
      </div>
    )
  }

  if (topLevelPosts.length === 0) {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto">
        {activeDisagreements.length > 0 && (
          <DisagreementBanner disagreements={activeDisagreements} />
        )}
        <div className="flex flex-1 items-center justify-center px-5 py-4">
          <EmptyState
            title="No posts yet"
            description="Messages will appear here as agents post to this channel."
          />
        </div>
      </div>
    )
  }

  return (
    <div className="scrollbar-thin flex-1 flex-col overflow-y-auto">
      {activeDisagreements.length > 0 && (
        <DisagreementBanner disagreements={activeDisagreements} />
      )}
      <div
        className="space-y-1 px-5 py-4"
        role="list"
        aria-label="Channel posts"
      >
        {topLevelPosts.map((post) => (
          <PostItem key={post.id} post={post} allPosts={sorted} />
        ))}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Disagreement banner
// ---------------------------------------------------------------------------

interface DisagreementEntry {
  disagreementId: string
  topic: string
  tieBreakerPersona: string | null
  status: string
}

function DisagreementBanner({ disagreements }: { disagreements: DisagreementEntry[] }) {
  return (
    <div
      className="border-b border-amber-200 bg-amber-50 px-5 py-2"
      role="alert"
      aria-live="polite"
    >
      {disagreements.map((d) => (
        <div key={d.disagreementId} className="flex items-center gap-2 text-sm text-amber-800">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            className="flex-shrink-0 text-amber-500"
            aria-hidden="true"
          >
            <path d="m10.29 3.86-8.6 14.9a1 1 0 0 0 .87 1.5h17.24a1 1 0 0 0 .87-1.5l-8.6-14.9a1 1 0 0 0-1.74 0z" />
            <line x1="12" y1="9" x2="12" y2="13" />
            <line x1="12" y1="17" x2="12.01" y2="17" />
          </svg>
          <span>
            <span className="font-semibold">Disagreement on {d.topic}</span>
            {d.tieBreakerPersona && (
              <span className="ml-1 text-amber-700">
                — tie-breaker assigned: <span className="font-medium">{d.tieBreakerPersona}</span>
              </span>
            )}
            {d.status === 'decided' && (
              <span className="ml-1 text-amber-600">(decision pending ADR)</span>
            )}
          </span>
        </div>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Author / payload extraction helpers
// ---------------------------------------------------------------------------

function extractAuthorName(actor: unknown): string {
  if (!actor || typeof actor !== 'object') return 'system'
  const a = actor as Record<string, unknown>
  if (typeof a['persona_role'] === 'string') return a['persona_role']
  if (typeof a['user_id'] === 'string') return a['user_id']
  if (typeof a['component'] === 'string') return a['component']
  return 'system'
}

function extractAuthorKind(actor: unknown): ChannelPost['authorKind'] {
  if (!actor || typeof actor !== 'object') return 'system'
  const a = actor as Record<string, unknown>
  switch (a['type']) {
    case 'persona':
      return 'persona'
    case 'user':
      return 'user'
    case 'hook':
      return 'hook'
    default:
      return 'system'
  }
}

function extractBody(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return ''
  const p = payload as Record<string, unknown>
  if (typeof p['body'] === 'string') return p['body']
  if (typeof p['text'] === 'string') return p['text']
  return ''
}
