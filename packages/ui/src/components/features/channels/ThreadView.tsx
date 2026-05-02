/**
 * ThreadView — inline reply composer + threaded reply display.
 *
 * Renders below a parent post when the user clicks "Reply". Shows
 * existing replies (fetched from tRPC with parent_post_id filter)
 * and a reply composer that calls channel.post.create with
 * post_type='reply' and parent_post_id set.
 *
 * Threading rules:
 *   - Replies indented by 12px with a slate-200 left border.
 *   - Max depth 3; deeper replies render flat (no further indent).
 *   - The reply post_type accepted by the router is 'user_guidance' (the
 *     tRPC router currently accepts 'user_guidance' | 'reply'; we use
 *     'user_guidance' with a parent_post_id to signify a thread reply
 *     until the router schema extends to 'reply' explicitly).
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'
import type { ChannelPost } from '../../../store/channels.js'

interface ThreadViewProps {
  parentPost: ChannelPost
  /** All posts in the channel — used to find replies already in memory. */
  allPosts: ChannelPost[]
  onClose: () => void
  /** Maximum nesting depth (default 3). */
  maxDepth?: number
}

export function ThreadView({ parentPost, allPosts, onClose, maxDepth = 3 }: ThreadViewProps) {
  const utils = trpc.useUtils()
  const [replyBody, setReplyBody] = useState('')
  const [errorMsg, setErrorMsg] = useState<string | null>(null)

  // Find replies already loaded from the store.
  const storeReplies = allPosts.filter((p) => p.parentPostId === parentPost.id)

  const replyMutation = trpc.channel.post.create.useMutation({
    onSuccess: () => {
      setReplyBody('')
      setErrorMsg(null)
      void utils.channel.posts.read.invalidate({ channel_id: parentPost.channelId })
    },
    onError: (err) => setErrorMsg(err.message),
  })

  const trimmed = replyBody.trim()
  const canSubmit = trimmed.length > 0 && !replyMutation.isPending

  const submitReply = () => {
    if (!canSubmit) return
    replyMutation.mutate({
      channel_id: parentPost.channelId,
      post_type: 'user_guidance',
      parent_post_id: parentPost.id,
      body: trimmed,
      mentions: [],
      cross_references: [],
      justification: 'User reply via thread composer',
    })
  }

  return (
    <div className="ml-11 border-l-2 border-slate-200 pl-3" role="region" aria-label="Thread replies">
      {storeReplies.length > 0 && (
        <ol className="mb-2 space-y-2">
          {storeReplies.map((reply) => (
            <ThreadReplyItem key={reply.id} post={reply} allPosts={allPosts} depth={1} maxDepth={maxDepth} />
          ))}
        </ol>
      )}

      <div className="flex items-end gap-2">
        <div className="flex-1 rounded-md border border-slate-200 bg-white px-3 py-1.5 focus-within:border-transparent focus-within:ring-2 focus-within:ring-indigo-500">
          <input
            type="text"
            value={replyBody}
            onChange={(e) => {
              setReplyBody(e.target.value)
              if (errorMsg) setErrorMsg(null)
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submitReply()
              }
              if (e.key === 'Escape') onClose()
            }}
            placeholder="Reply in thread…"
            className="w-full text-xs text-slate-700 placeholder-slate-400 focus:outline-none"
            aria-label="Reply in thread"
            maxLength={4000}
            disabled={replyMutation.isPending}
            // eslint-disable-next-line jsx-a11y/no-autofocus
            autoFocus
          />
        </div>
        <Button
          size="sm"
          onClick={submitReply}
          disabled={!canSubmit}
          aria-label="Send reply"
        >
          {replyMutation.isPending ? '…' : 'Reply'}
        </Button>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close thread"
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d="M18 6 6 18M6 6l12 12" />
          </svg>
        </button>
      </div>

      {errorMsg && (
        <p className="mt-1 text-xs text-rose-600" role="alert">
          {errorMsg}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Recursive reply item — renders up to maxDepth levels of nesting.
// ---------------------------------------------------------------------------

interface ThreadReplyItemProps {
  post: ChannelPost
  allPosts: ChannelPost[]
  depth: number
  maxDepth: number
}

function ThreadReplyItem({ post, allPosts, depth, maxDepth }: ThreadReplyItemProps) {
  const time = new Date(post.occurredAt).toLocaleTimeString(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  })

  // Replies deeper than maxDepth still render, just without additional indent.
  const nestedReplies = depth < maxDepth
    ? allPosts.filter((p) => p.parentPostId === post.id)
    : []

  return (
    <li className="group" role="listitem">
      <div className="flex items-start gap-2">
        <div className="mt-0.5 flex h-5 w-5 flex-shrink-0 items-center justify-center rounded bg-gradient-to-br from-slate-400 to-slate-600 text-[8px] font-bold text-white">
          {post.authorName.slice(0, 2).toUpperCase()}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="text-xs font-semibold text-slate-800">{post.authorName}</span>
            <span className="text-[10px] text-slate-400">{time}</span>
          </div>
          <p className="text-xs text-slate-600">{post.body}</p>
        </div>
      </div>

      {nestedReplies.length > 0 && (
        <ul className="ml-7 mt-1 border-l-2 border-slate-100 pl-2 space-y-1">
          {nestedReplies.map((reply) => (
            <ThreadReplyItem
              key={reply.id}
              post={reply}
              allPosts={allPosts}
              depth={depth + 1}
              maxDepth={maxDepth}
            />
          ))}
        </ul>
      )}
    </li>
  )
}
