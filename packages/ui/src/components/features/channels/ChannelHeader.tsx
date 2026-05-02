/**
 * ChannelHeader — name + kind summary + presence row + pinned posts.
 */

import type { Channel } from '../../../store/channels.js'
import { useChannelsStore } from '../../../store/channels.js'
import { PresenceRow } from './PresenceRow.js'
import { PinnedPosts } from './PinnedPosts.js'

export function ChannelHeader({ channel }: { channel: Channel }) {
  const posts = useChannelsStore((s) => s.posts[channel.id] ?? [])
  const pinnedPosts = posts.filter((p) => !!p.pinnedAt)

  return (
    <div className="border-b border-slate-200">
      <header className="flex items-center justify-between px-5 py-3">
        <div>
          <div className="flex items-center gap-2">
            <span className="text-lg text-slate-400" aria-hidden="true">
              #
            </span>
            <span className="text-base font-semibold text-slate-900">{channel.name}</span>
            <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-slate-500">
              {channel.kind}
            </span>
          </div>
        </div>
      </header>

      {/* Presence strip — only visible when agents are live */}
      <PresenceRow channelId={channel.id} />

      {/* Pinned posts — only visible when there are pinned posts */}
      <PinnedPosts channelId={channel.id} pinnedPosts={pinnedPosts} />
    </div>
  )
}
