/**
 * PinnedPosts — renders the pinned posts strip above the post feed.
 *
 * Queries channel.posts.read with post_types filter for pinned posts.
 * Since the backend doesn't have a separate pinned query yet, we filter
 * for posts that have been marked pinned via a local field.
 *
 * DEFERRED: channel.posts.pin tRPC procedure not in AppRouter.
 * The Pin button on PostItem is visible but disabled with tooltip
 * "Backend procedure pending". This component simply shows posts that
 * arrive via WS with isPinned=true (future enhancement). For now it
 * renders empty/nothing gracefully.
 */

import type { ChannelPost } from '../../../store/channels.js'

interface PinnedPostsProps {
  channelId: string
  /** Posts already loaded in the feed; caller passes them to avoid double-fetch. */
  pinnedPosts: ChannelPost[]
}

export function PinnedPosts({ channelId: _channelId, pinnedPosts }: PinnedPostsProps) {
  if (pinnedPosts.length === 0) return null

  return (
    <div
      className="border-b border-amber-100 bg-amber-50 px-5 py-2"
      aria-label="Pinned posts"
      role="region"
    >
      <div className="mb-1.5 flex items-center gap-1.5">
        <PinIcon className="h-3 w-3 text-amber-500" aria-hidden="true" />
        <span className="text-[10px] font-semibold uppercase tracking-wider text-amber-700">
          Pinned
        </span>
      </div>
      <ul className="space-y-1">
        {pinnedPosts.map((post) => (
          <li
            key={post.id}
            className="flex items-start gap-2 text-xs text-slate-700"
            role="listitem"
          >
            <span className="font-medium text-slate-500">{post.authorName}:</span>
            <span className="truncate">{post.body}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function PinIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 17v5" />
      <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
    </svg>
  )
}
