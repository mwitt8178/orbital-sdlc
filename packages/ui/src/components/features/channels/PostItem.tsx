/**
 * PostItem — typed channel post rendering.
 *
 * Different post types render with different visual treatments per the
 * prototype:
 *   - blocker         → rose-500 left border + "BLOCKER" badge in red
 *   - decision        → indigo-500 left border + "DECISION" badge + ADR link
 *   - alert           → amber-500 background tint + "ALERT" icon
 *   - capability_event → violet-500 left border + lock icon
 *   - system_event    → muted slate styling, smaller text
 *   - cross_post      → "Cross-posted from #channel" badge
 *   - status_update / user_guidance → default white card
 *
 * Hover toolbar: Reply · Pin (deferred) · React (deferred)
 *
 * DEFERRED:
 *   - channel.posts.pin    — button visible but disabled ("Backend procedure pending")
 *   - channel.posts.react  — reaction bar disabled ("Backend procedure pending")
 */

import { useState } from 'react'
import clsx from 'clsx'
import type { ChannelPost } from '../../../store/channels.js'
import { Badge } from '../../ui/Badge.js'
import { ReactionBar } from './ReactionBar.js'
import { ThreadView } from './ThreadView.js'

interface PostItemProps {
  post: ChannelPost
  /** All posts in channel — passed into ThreadView for reply rendering. */
  allPosts?: ChannelPost[]
  /** Current nesting depth. Top-level = 0; we don't render top-level items
   * that are replies (they belong inside ThreadView). */
  isThreadReply?: boolean
}

export function PostItem({ post, allPosts = [], isThreadReply = false }: PostItemProps) {
  const [showThread, setShowThread] = useState(false)
  const [isHovered, setIsHovered] = useState(false)

  const time = new Date(post.occurredAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })

  const replyCount = allPosts.filter((p) => p.parentPostId === post.id).length

  if (post.postType === 'system_event') {
    return (
      <div className="flex items-center gap-2 px-2 py-1 text-[12px] text-slate-400 italic" role="listitem">
        <span className="text-slate-300" aria-hidden="true">·</span>
        <span>{post.body}</span>
        <span className="ml-auto font-mono text-[10px]">{time}</span>
      </div>
    )
  }

  const leftBarClass = clsx(
    'border-l-4',
    post.postType === 'blocker' && 'border-rose-500',
    post.postType === 'decision' && 'border-indigo-500',
    post.postType === 'capability_event' && 'border-violet-500',
    (post.postType === 'alert') && 'border-amber-400',
    (post.postType === 'status_update' || post.postType === 'cross_post' || post.postType === 'user_guidance') && 'border-transparent',
  )

  const bgClass = clsx(
    post.postType === 'alert' && 'bg-amber-50',
  )

  return (
    <div role="listitem">
      <div
        className={clsx(
          'group relative flex gap-3 rounded px-2 py-2 transition -mx-2 animate-stream-in pl-3',
          !isHovered && 'hover:bg-slate-50',
          leftBarClass,
          bgClass,
          isHovered && 'bg-slate-50',
        )}
        onMouseEnter={() => setIsHovered(true)}
        onMouseLeave={() => setIsHovered(false)}
      >
        {/* Avatar */}
        <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-gradient-to-br from-indigo-500 to-violet-600 text-[10px] font-bold text-white">
          {post.authorName.slice(0, 2).toUpperCase()}
        </div>

        {/* Content */}
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-sm font-bold text-slate-900">{post.authorName}</span>
            <span className="text-[11px] text-slate-400">{time}</span>
            <PostTypeBadge post={post} />
          </div>

          <div className="mt-1 text-sm text-slate-700">{post.body}</div>

          {/* Cross-post badge */}
          {post.postType === 'cross_post' && post.crossPostFromChannel && (
            <div className="mt-1">
              <span className="inline-flex items-center gap-1 rounded border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] text-slate-500">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                Cross-posted from #{post.crossPostFromChannel}
              </span>
            </div>
          )}

          {/* ADR link for decision posts */}
          {post.postType === 'decision' && post.linkedAdrId && (
            <div className="mt-1">
              <span className="inline-flex items-center gap-1 text-[11px] text-indigo-600">
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                  <polyline points="14 2 14 8 20 8" />
                </svg>
                ADR: {post.linkedAdrId}
              </span>
            </div>
          )}

          {/* Thread reply count */}
          {replyCount > 0 && !showThread && (
            <button
              type="button"
              onClick={() => setShowThread(true)}
              className="mt-1.5 flex items-center gap-1 text-[11px] text-indigo-600 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
              aria-label={`View ${replyCount} ${replyCount === 1 ? 'reply' : 'replies'}`}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
              {replyCount} {replyCount === 1 ? 'reply' : 'replies'}
            </button>
          )}
        </div>

        {/* Hover toolbar */}
        <div
          className={clsx(
            'absolute right-2 top-1.5 flex items-center gap-1 transition-opacity',
            isHovered ? 'opacity-100' : 'opacity-0 pointer-events-none',
          )}
          aria-label="Post actions"
        >
          {/* React */}
          <ReactionBar postId={post.id} />

          {/* Reply */}
          {!isThreadReply && (
            <button
              type="button"
              onClick={() => setShowThread((v) => !v)}
              aria-label={showThread ? 'Close thread' : 'Reply in thread'}
              className="rounded p-1 text-slate-400 hover:bg-white hover:text-indigo-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
              </svg>
            </button>
          )}

          {/* Pin — deferred, backend procedure pending */}
          <button
            type="button"
            disabled
            title="Pin — backend procedure pending"
            aria-label="Pin post (backend procedure pending)"
            className="rounded p-1 text-slate-300 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:pointer-events-none disabled:opacity-40"
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <path d="M12 17v5" />
              <path d="M9 10.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24V16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V7a1 1 0 0 1 1-1 2 2 0 0 0 0-4H8a2 2 0 0 0 0 4 1 1 0 0 1 1 1z" />
            </svg>
          </button>
        </div>
      </div>

      {/* Inline thread */}
      {showThread && !isThreadReply && (
        <ThreadView
          parentPost={post}
          allPosts={allPosts}
          onClose={() => setShowThread(false)}
        />
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Post type badge
// ---------------------------------------------------------------------------

function PostTypeBadge({ post }: { post: ChannelPost }) {
  switch (post.postType) {
    case 'decision':
      return (
        <span className="flex items-center gap-1">
          <Badge color="indigo">DECISION</Badge>
        </span>
      )
    case 'blocker':
      return <Badge color="rose">BLOCKER</Badge>
    case 'alert':
      return (
        <span className="flex items-center gap-1">
          <AlertIcon className="h-3 w-3 text-amber-500" />
          <Badge color="amber">ALERT</Badge>
        </span>
      )
    case 'capability_event':
      return (
        <span className="flex items-center gap-1">
          <LockIcon className="h-3 w-3 text-violet-500" />
          <Badge color="violet">Capability</Badge>
        </span>
      )
    case 'cross_post':
      return <Badge color="slate">Cross-post</Badge>
    case 'user_guidance':
      return <Badge color="indigo">Guidance</Badge>
    case 'status_update':
    case 'system_event':
    default:
      return null
  }
}

function AlertIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <path d="m10.29 3.86-8.6 14.9a1 1 0 0 0 .87 1.5h17.24a1 1 0 0 0 .87-1.5l-8.6-14.9a1 1 0 0 0-1.74 0z" />
      <line x1="12" y1="9" x2="12" y2="13" />
      <line x1="12" y1="17" x2="12.01" y2="17" />
    </svg>
  )
}

function LockIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
      <path d="M7 11V7a5 5 0 0 1 10 0v4" />
    </svg>
  )
}
