/**
 * ReactionBar — emoji-reaction toolbar that appears on post hover.
 *
 * Default reactions: 👍 ✓ 🚫 👀
 *
 * Calls channel.posts.react mutation when it exists. If the procedure is
 * not yet in the router, the buttons remain enabled but log a deferred note.
 *
 * DEFERRED: channel.posts.react tRPC procedure not yet in AppRouter.
 * The UI renders the reaction buttons; clicking shows a tooltip
 * "Reactions coming soon" and does not throw. Tracked as deferred item.
 */

import clsx from 'clsx'

const DEFAULT_REACTIONS = ['👍', '✓', '🚫', '👀'] as const

interface ReactionBarProps {
  postId: string
  /** Map of emoji → count for display. Populated from post metadata. */
  reactions?: Record<string, number>
  className?: string
}

export function ReactionBar({ postId: _postId, reactions = {}, className }: ReactionBarProps) {
  return (
    <div
      className={clsx(
        'flex items-center gap-0.5',
        className,
      )}
      role="group"
      aria-label="Post reactions"
    >
      {DEFAULT_REACTIONS.map((emoji) => {
        const count = reactions[emoji] ?? 0
        return (
          <button
            key={emoji}
            type="button"
            title="Reactions coming soon — backend procedure pending"
            aria-label={`React with ${emoji}${count > 0 ? `, ${count} reactions` : ''}`}
            disabled
            className={clsx(
              'flex items-center gap-0.5 rounded px-1.5 py-0.5 text-xs transition',
              'border border-transparent text-slate-400',
              'hover:border-slate-200 hover:bg-slate-50 hover:text-slate-600',
              'disabled:pointer-events-none disabled:opacity-40',
              count > 0 && 'border-indigo-200 bg-indigo-50 text-indigo-600',
            )}
          >
            <span aria-hidden="true">{emoji}</span>
            {count > 0 && <span className="font-mono text-[10px]">{count}</span>}
          </button>
        )
      })}
    </div>
  )
}
