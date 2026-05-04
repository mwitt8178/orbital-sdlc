/**
 * AgentTalkView — visualizes agent-to-agent channel conversations for a task
 * or sprint.
 *
 * Round 6 #9 — Inter-Agent Channel Collaboration
 * [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
 *
 * Shows sender → receiver edges with time, channel, and message excerpt.
 * Helps operators see "the team is collaborating" at a glance.
 *
 * Props:
 *   mode      — 'task' | 'sprint'
 *   id        — task_id or sprint_id depending on mode
 *   maxItems  — max messages to display (default 20)
 */

import { trpc } from '../../../services/trpc.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentTalkViewProps {
  /** 'task' — show posts from the worker assigned to this task */
  workerId: string
  /** Optional title for the section header */
  title?: string
  /** Max messages (default 20) */
  maxItems?: number
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function personaIcon(personaId: string): string {
  const icons: Record<string, string> = {
    'jr-dev': 'JR',
    'sr-dev': 'SR',
    'principal-dev': 'PR',
    architect: 'AR',
    em: 'EM',
    qa: 'QA',
    security: 'SE',
    reviewer: 'RV',
    verifier: 'VR',
    pm: 'PM',
  }
  return icons[personaId] ?? personaId.slice(0, 2).toUpperCase()
}

function channelColor(channelName: string): string {
  if (channelName.startsWith('#escalation-')) return 'bg-red-100 text-red-700'
  if (channelName.startsWith('#sprint-')) return 'bg-blue-100 text-blue-700'
  if (channelName.startsWith('#review-')) return 'bg-violet-100 text-violet-700'
  if (channelName.startsWith('#orb-')) return 'bg-emerald-100 text-emerald-700'
  return 'bg-slate-100 text-slate-700'
}

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function bodyExcerpt(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return ''
  const p = payload as Record<string, unknown>
  if (typeof p['body'] === 'string') return p['body'].slice(0, 200)
  return ''
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AgentTalkView({ workerId, title = 'Agent activity', maxItems = 20 }: AgentTalkViewProps) {
  const { data, isLoading } = trpc.channel.byWorker.useQuery(
    { worker_id: workerId, limit: maxItems },
    { refetchInterval: 10_000 },
  )

  type PostItem = NonNullable<typeof data>['items'][number]
  const posts: PostItem[] = data?.items ?? []

  if (isLoading) {
    return (
      <div className="space-y-2 p-4">
        {[...Array(3)].map((_, i) => (
          <div key={i} className="h-12 animate-pulse rounded-lg bg-slate-100" />
        ))}
      </div>
    )
  }

  if (posts.length === 0) {
    return (
      <div className="flex items-center justify-center px-4 py-8 text-sm text-slate-400">
        No channel activity yet
      </div>
    )
  }

  return (
    <section aria-label={title} className="space-y-1">
      {title && (
        <h3 className="px-4 pb-1 pt-2 text-xs font-semibold uppercase tracking-wider text-slate-500">
          {title}
        </h3>
      )}
      <ul className="divide-y divide-slate-100">
        {posts.map((post) => {
          const actorPersonaId = (post.author_actor as Record<string, unknown>)?.['persona_id'] as string ?? 'unknown'
          const excerpt = bodyExcerpt(post.payload)

          return (
            <li key={post.post_id} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50">
              {/* Persona avatar */}
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-slate-200 text-xs font-semibold text-slate-600">
                {personaIcon(actorPersonaId)}
              </div>

              {/* Message content */}
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-semibold text-slate-700">{actorPersonaId}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-xs font-medium ${channelColor(post.channel_name)}`}
                  >
                    {post.channel_name}
                  </span>
                  <span className="text-xs text-slate-400">{formatRelativeTime(post.created_at)}</span>
                </div>
                {excerpt && (
                  <p className="mt-0.5 truncate text-xs text-slate-500">{excerpt}</p>
                )}
                <div className="mt-0.5 flex items-center gap-2">
                  <span className="text-xs text-slate-400">{post.post_type}</span>
                  {post.tokens_consumed != null && post.tokens_consumed > 0 && (
                    <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                      {post.tokens_consumed.toLocaleString()} tokens
                    </span>
                  )}
                </div>
              </div>
            </li>
          )
        })}
      </ul>
    </section>
  )
}
