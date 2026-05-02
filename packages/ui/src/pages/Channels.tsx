/**
 * Channels page — channel sidebar + active feed + composer.
 *
 * Round 6 #9 — Inter-Agent Channel Collaboration: added "Agent activity" tab
 * that filters to AgentChannelPosted events and shows per-message persona icon
 * + cost-of-this-message badge.
 * [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { useChannelsStore } from '../store/channels.js'
import { ChannelList } from '../components/features/channels/ChannelList.js'
import { ChannelHeader } from '../components/features/channels/ChannelHeader.js'
import { PostFeed } from '../components/features/channels/PostFeed.js'
import { PostComposer } from '../components/features/channels/PostComposer.js'
import { trpc } from '../services/trpc.js'
import clsx from 'clsx'
// Round 7-08 — Operator-Attributed UI: per-message author badge
// [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
import { OperatorBadge, type TeamMember } from '../components/identity/OperatorBadge.js'

// ---------------------------------------------------------------------------
// Agent activity tab
// ---------------------------------------------------------------------------

interface AgentPost {
  post_id: string
  channel_name: string
  post_type: string
  payload: unknown
  author_actor: unknown
  tokens_consumed: number | null
  created_at: string
}

function bodyExcerpt(payload: unknown): string {
  if (typeof payload !== 'object' || payload === null) return ''
  const p = payload as Record<string, unknown>
  if (typeof p['body'] === 'string') return p['body'].slice(0, 300)
  return ''
}

function formatRelativeTime(isoString: string): string {
  const diff = Date.now() - new Date(isoString).getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  return `${Math.floor(diff / 86_400_000)}d ago`
}

function channelTagColor(name: string): string {
  if (name.startsWith('#escalation-')) return 'bg-red-100 text-red-700'
  if (name.startsWith('#review-')) return 'bg-purple-100 text-purple-700'
  if (name.startsWith('#sprint-')) return 'bg-blue-100 text-blue-700'
  return 'bg-slate-100 text-slate-700'
}

function personaInitials(actorObj: unknown): string {
  if (typeof actorObj !== 'object' || actorObj === null) return '?'
  const a = actorObj as Record<string, unknown>
  const pid = typeof a['persona_id'] === 'string' ? a['persona_id'] : '?'
  const map: Record<string, string> = {
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
  return map[pid] ?? pid.slice(0, 2).toUpperCase()
}

interface AgentActivityFeedProps {
  channelId: string
}

function AgentActivityFeed({ channelId }: AgentActivityFeedProps) {
  // Fetch recent posts from all workers for this channel.
  // We show posts where post_type indicates agent authorship.
  const { data, isLoading } = trpc.channel.posts.read.useQuery(
    { channel_id: channelId, limit: 100 },
    { refetchInterval: 8_000 },
  )
  const channelsData = trpc.channel.list.useQuery({}, { staleTime: 60_000 })
  const channelName = channelsData.data?.items.find((c: { channel_id: string }) => c.channel_id === channelId) as { name: string } | undefined
  const resolvedChannelName = channelName?.name ?? ''
  // Round 7-08 — Operator-Attributed UI: load team members for per-message badge
  // [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
  const membersQuery = trpc.team.members.useQuery(undefined, { staleTime: 30_000 })
  const memberMap = new Map<string, TeamMember>(
    (membersQuery.data ?? []).map((m) => [m.install_id, {
      install_id: m.install_id,
      display_name: m.display_name,
      role: m.role,
      last_seen_at: m.last_seen_at,
      color: m.color,
    }]),
  )

  if (isLoading) {
    return (
      <div className="flex-1 space-y-3 overflow-y-auto p-4">
        {[...Array(4)].map((_, i) => (
          <div key={i} className="h-14 animate-pulse rounded-lg bg-slate-100" />
        ))}
      </div>
    )
  }

  // Filter to agent-authored posts only (author_actor.type === 'persona')
  type PostItem = NonNullable<typeof data>['items'][number]
  const agentPosts: AgentPost[] = (data?.items ?? [] as PostItem[])
    .filter((p: PostItem) => {
      const a = p.author_actor as Record<string, unknown>
      return a?.['type'] === 'persona'
    })
    .map((p: PostItem) => ({
      post_id: p.post_id,
      channel_name: resolvedChannelName,
      post_type: p.post_type,
      payload: p.payload,
      author_actor: p.author_actor,
      tokens_consumed: p.tokens_consumed ?? null,
      created_at: p.created_at,
    }))

  if (agentPosts.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center text-sm text-slate-400">
        No agent posts in this channel yet
      </div>
    )
  }

  return (
    <ul className="flex-1 divide-y divide-slate-100 overflow-y-auto">
      {agentPosts.map((post) => {
        const initials = personaInitials(post.author_actor)
        const actor = post.author_actor as Record<string, unknown>
        const personaId = (actor?.['persona_id'] as string) ?? 'unknown'
        const installId = (actor?.['install_id'] as string | undefined)
        const member = installId ? memberMap.get(installId) : undefined
        const excerpt = bodyExcerpt(post.payload)

        return (
          <li key={post.post_id} className="flex items-start gap-3 px-4 py-3 hover:bg-slate-50">
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 text-xs font-semibold text-indigo-700">
              {initials}
            </div>
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                {/* Round 7-08 — show OperatorBadge if install_id is known */}
                {installId && member ? (
                  <OperatorBadge
                    installId={installId}
                    member={member}
                    size="sm"
                  />
                ) : (
                  <span className="text-xs font-semibold text-slate-800">{personaId}</span>
                )}
                <span
                  className={clsx(
                    'rounded-full px-2 py-0.5 text-xs font-medium',
                    channelTagColor(post.channel_name),
                  )}
                >
                  {post.channel_name}
                </span>
                <span className="text-xs text-slate-400">{post.post_type}</span>
                {post.tokens_consumed != null && post.tokens_consumed > 0 && (
                  <span className="rounded bg-slate-100 px-1.5 py-0.5 text-xs text-slate-500">
                    {post.tokens_consumed.toLocaleString()} tokens
                  </span>
                )}
                <span className="ml-auto text-xs text-slate-400">
                  {formatRelativeTime(post.created_at)}
                </span>
              </div>
              {excerpt && (
                <p className="mt-1 line-clamp-2 text-xs text-slate-600">{excerpt}</p>
              )}
            </div>
          </li>
        )
      })}
    </ul>
  )
}

// ---------------------------------------------------------------------------
// Main page
// ---------------------------------------------------------------------------

type ActiveTab = 'feed' | 'agent-activity'

export default function Channels() {
  const channels = useChannelsStore((s) => s.channels)
  const activeChannelId = useChannelsStore((s) => s.activeChannelId)
  const activeChannel = channels.find((c) => c.id === activeChannelId)
  const noChannelsAtAll = channels.length === 0
  const [activeTab, setActiveTab] = useState<ActiveTab>('feed')

  return (
    <div className="flex" style={{ height: 'calc(100vh - 56px)' }}>
      <h1 className="sr-only">Channels</h1>
      <ChannelList />

      <section
        className="flex flex-1 flex-col bg-white"
        aria-label={activeChannel ? `Channel ${activeChannel.name}` : 'Channel feed'}
      >
        {activeChannel ? (
          <>
            <ChannelHeader channel={activeChannel} />

            {/* Tab bar */}
            <div className="flex border-b border-slate-200" role="tablist" aria-label="Channel view">
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'feed'}
                onClick={() => setActiveTab('feed')}
                className={clsx(
                  'px-4 py-2 text-sm font-medium transition-colors',
                  activeTab === 'feed'
                    ? 'border-b-2 border-brand-600 text-brand-600'
                    : 'text-slate-500 hover:text-slate-700',
                )}
              >
                Messages
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={activeTab === 'agent-activity'}
                onClick={() => setActiveTab('agent-activity')}
                className={clsx(
                  'px-4 py-2 text-sm font-medium transition-colors',
                  activeTab === 'agent-activity'
                    ? 'border-b-2 border-brand-600 text-brand-600'
                    : 'text-slate-500 hover:text-slate-700',
                )}
              >
                Agent activity
              </button>
            </div>

            {activeTab === 'feed' ? (
              <>
                <PostFeed channelId={activeChannel.id} />
                <PostComposer channelId={activeChannel.id} />
              </>
            ) : (
              <AgentActivityFeed channelId={activeChannel.id} />
            )}
          </>
        ) : noChannelsAtAll ? (
          <div className="flex flex-1 items-center justify-center px-6">
            <div className="max-w-md rounded-lg border border-dashed border-slate-200 bg-white px-6 py-10 text-center">
              <div className="mx-auto mb-3 flex h-10 w-10 items-center justify-center rounded-full bg-slate-100 text-slate-400">
                <svg
                  width="20"
                  height="20"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
              </div>
              <h3 className="text-sm font-semibold text-slate-900">No channels yet</h3>
              <p className="mt-1 text-xs text-slate-500">
                Channels are auto-created per sprint and per ticket.
              </p>
              <Link
                to="/"
                className="mt-3 inline-flex items-center text-xs font-medium text-brand-600 hover:text-brand-700"
              >
                Start a sprint →
              </Link>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 items-center justify-center px-6">
            <div className="max-w-md rounded-lg border border-dashed border-slate-200 bg-white px-6 py-10 text-center">
              <h3 className="text-sm font-semibold text-slate-900">Select a channel</h3>
              <p className="mt-1 text-xs text-slate-500">
                Choose a channel from the list to view posts.
              </p>
            </div>
          </div>
        )}
      </section>
    </div>
  )
}
