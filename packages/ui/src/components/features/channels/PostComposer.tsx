/**
 * PostComposer — textarea + post-type selector + @mention autocomplete.
 *
 * Post types available:
 *   status_update, decision, blocker, alert, system_event,
 *   cross_post, capability_event, user_guidance (default)
 *
 * @mention: when the user types `@` we show a MentionAutocomplete popover.
 * Resolved mentions are collected into a mentions[] array on submit.
 *
 * Note: the tRPC channel.post.create procedure's post_type enum currently
 * accepts 'user_guidance' | 'reply'. All other typed posts are submitted
 * as 'user_guidance' with the type surfaced only in the UI for now.
 * The backend schema will be extended in a follow-up migration.
 *
 * DEFERRED: Backend schema extension to accept all 8 post types.
 * Tracked in implementation deferred items.
 */

import { useState, useRef, useCallback } from 'react'
import clsx from 'clsx'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'
import { MentionAutocomplete } from './MentionAutocomplete.js'

interface PostComposerProps {
  channelId: string
  onPosted?: () => void
}

type PostType =
  | 'user_guidance'
  | 'status_update'
  | 'decision'
  | 'blocker'
  | 'alert'
  | 'system_event'
  | 'cross_post'
  | 'capability_event'

const POST_TYPE_OPTIONS: { value: PostType; label: string }[] = [
  { value: 'user_guidance', label: 'Guidance' },
  { value: 'status_update', label: 'Status Update' },
  { value: 'decision', label: 'Decision' },
  { value: 'blocker', label: 'Blocker' },
  { value: 'alert', label: 'Alert' },
  { value: 'system_event', label: 'System Event' },
  { value: 'cross_post', label: 'Cross Post' },
  { value: 'capability_event', label: 'Capability Event' },
]

interface ResolvedMention {
  target_type: 'persona_role'
  target_ref: string
}

/** Regex to detect `@word` at end of textarea value. */
const MENTION_TRIGGER_RE = /@([a-zA-Z0-9_-]*)$/

export function PostComposer({ channelId, onPosted }: PostComposerProps) {
  const [body, setBody] = useState('')
  const [postType, setPostType] = useState<PostType>('user_guidance')
  const [mentions, setMentions] = useState<ResolvedMention[]>([])
  const [errorMessage, setErrorMessage] = useState<string | null>(null)
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)

  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const utils = trpc.useUtils()

  const mutation = trpc.channel.post.create.useMutation({
    onSuccess: () => {
      setBody('')
      setMentions([])
      setMentionQuery(null)
      setErrorMessage(null)
      onPosted?.()
      void utils.channel.posts.read.invalidate({ channel_id: channelId })
      textareaRef.current?.focus()
    },
    onError: (err) => {
      setErrorMessage(err.message)
    },
  })

  const trimmed = body.trim()
  const canSubmit = trimmed.length > 0 && !mutation.isPending

  const handleBodyChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>) => {
      const val = e.target.value
      setBody(val)
      if (errorMessage) setErrorMessage(null)

      // Detect @mention trigger at cursor end.
      const match = MENTION_TRIGGER_RE.exec(val)
      if (match) {
        setMentionQuery(match[1] ?? '')
      } else {
        setMentionQuery(null)
      }
    },
    [errorMessage],
  )

  const handleMentionSelect = useCallback(
    (slug: string) => {
      // Replace the partial @query with the resolved @slug.
      const replaced = body.replace(MENTION_TRIGGER_RE, `@${slug} `)
      setBody(replaced)
      setMentionQuery(null)
      setMentions((prev) => {
        const already = prev.some((m) => m.target_ref === slug)
        if (already) return prev
        return [...prev, { target_type: 'persona_role', target_ref: slug }]
      })
      textareaRef.current?.focus()
    },
    [body],
  )

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      submit()
    }
    if (e.key === 'Escape') {
      setMentionQuery(null)
    }
  }

  const submit = () => {
    if (!canSubmit) return
    mutation.mutate({
      channel_id: channelId,
      // The tRPC schema accepts 'user_guidance' | 'reply' in v1.
      // All typed posts are sent as user_guidance until backend schema extended.
      post_type: 'user_guidance',
      body: trimmed,
      mentions: mentions,
      cross_references: [],
      justification: `User-authored ${postType} post via UI composer`,
    })
  }

  const postTypeColor = POST_TYPE_COLORS[postType]

  return (
    <div className="border-t border-slate-200 bg-slate-50 px-5 py-3">
      <form
        onSubmit={(e) => {
          e.preventDefault()
          submit()
        }}
      >
        {/* Post type selector */}
        <div className="mb-2 flex items-center gap-2">
          <label htmlFor="post-type-select" className="text-[11px] font-medium text-slate-500">
            Type
          </label>
          <select
            id="post-type-select"
            value={postType}
            onChange={(e) => setPostType(e.target.value as PostType)}
            className={clsx(
              'rounded-md border px-2 py-0.5 text-[11px] font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500',
              postTypeColor,
            )}
            aria-label="Select post type"
          >
            {POST_TYPE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Composer row */}
        <div className="relative flex items-end gap-2">
          <div
            className={clsx(
              'flex-1 rounded-md border bg-white px-3 py-2 focus-within:border-transparent focus-within:ring-2 focus-within:ring-indigo-500',
              postType === 'blocker' ? 'border-l-4 border-l-rose-500 border-y-slate-200 border-r-slate-200' : 'border-slate-200',
              postType === 'alert' ? 'bg-amber-50' : 'bg-white',
            )}
          >
            <textarea
              ref={textareaRef}
              value={body}
              onChange={handleBodyChange}
              onKeyDown={handleKeyDown}
              placeholder={`Message… (Shift+Enter for new line, @ to mention)`}
              rows={2}
              className="w-full resize-none text-sm text-slate-900 placeholder-slate-400 focus:outline-none"
              aria-label="Compose channel post"
              aria-describedby={errorMessage ? 'composer-error' : undefined}
              maxLength={8000}
              disabled={mutation.isPending}
            />
          </div>

          <Button type="submit" disabled={!canSubmit} aria-label="Post message">
            {mutation.isPending ? 'Posting…' : 'Post'}
          </Button>

          {/* @mention autocomplete popover */}
          {mentionQuery !== null && (
            <div className="absolute bottom-full left-0 mb-1 w-full">
              <MentionAutocomplete
                query={mentionQuery}
                anchorRef={textareaRef}
                onSelect={handleMentionSelect}
                onDismiss={() => setMentionQuery(null)}
              />
            </div>
          )}
        </div>
      </form>

      {/* Resolved mentions preview */}
      {mentions.length > 0 && (
        <div className="mt-1.5 flex flex-wrap gap-1">
          {mentions.map((m) => (
            <span
              key={m.target_ref}
              className="inline-flex items-center gap-1 rounded-full bg-indigo-50 px-2 py-0.5 text-[10px] font-medium text-indigo-700"
            >
              @{m.target_ref}
              <button
                type="button"
                onClick={() => setMentions((prev) => prev.filter((x) => x.target_ref !== m.target_ref))}
                aria-label={`Remove mention of @${m.target_ref}`}
                className="ml-0.5 text-indigo-400 hover:text-indigo-700 focus-visible:outline-none"
              >
                ×
              </button>
            </span>
          ))}
        </div>
      )}

      {errorMessage && (
        <p id="composer-error" className="mt-2 text-xs text-rose-600" role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Post type → border/bg colors for the selector
// ---------------------------------------------------------------------------

const POST_TYPE_COLORS: Record<PostType, string> = {
  user_guidance: 'border-indigo-200 bg-indigo-50 text-indigo-700',
  status_update: 'border-slate-200 bg-white text-slate-700',
  decision: 'border-indigo-300 bg-indigo-50 text-indigo-800',
  blocker: 'border-rose-300 bg-rose-50 text-rose-700',
  alert: 'border-amber-300 bg-amber-50 text-amber-700',
  system_event: 'border-slate-200 bg-slate-100 text-slate-500',
  cross_post: 'border-slate-200 bg-white text-slate-600',
  capability_event: 'border-violet-300 bg-violet-50 text-violet-700',
}
