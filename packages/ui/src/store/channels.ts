import { create } from 'zustand'

export type ChannelKind =
  | 'sprint'
  | 'epic'
  | 'ticket_durable'
  | 'ticket_scratch'
  | 'topic'
  | 'ceremony'

export interface Channel {
  id: string
  name: string
  kind: ChannelKind
  unreadCount: number
}

export interface ChannelPost {
  id: string
  channelId: string
  authorName: string
  authorKind: 'persona' | 'user' | 'system' | 'hook'
  postType: 'status_update' | 'decision' | 'blocker' | 'alert' | 'system_event' | 'cross_post' | 'capability_event' | 'user_guidance'
  body: string
  occurredAt: string
  /** ID of the parent post for threaded replies. */
  parentPostId?: string | null
  /** Cross-post source channel name for cross_post type. */
  crossPostFromChannel?: string | null
  /** ADR reference link for decision type. */
  linkedAdrId?: string | null
  /** Whether this post is pinned in the channel. */
  pinnedAt?: string | null
}

interface ChannelsState {
  channels: Channel[]
  posts: Record<string, ChannelPost[]>
  activeChannelId: string | null
  setChannels: (channels: Channel[]) => void
  setActiveChannelId: (id: string | null) => void
  appendPost: (channelId: string, post: ChannelPost) => void
  setPosts: (channelId: string, posts: ChannelPost[]) => void
}

export const useChannelsStore = create<ChannelsState>((set) => ({
  channels: [],
  posts: {},
  activeChannelId: null,
  setChannels: (channels) => set({ channels }),
  setActiveChannelId: (id) => set({ activeChannelId: id }),
  appendPost: (channelId, post) =>
    set((state) => ({
      posts: {
        ...state.posts,
        [channelId]: [...(state.posts[channelId] ?? []), post],
      },
    })),
  setPosts: (channelId, posts) =>
    set((state) => ({
      posts: { ...state.posts, [channelId]: posts },
    })),
}))
