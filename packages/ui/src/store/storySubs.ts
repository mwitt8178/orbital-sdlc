/**
 * storySubs — track per-story WS subscription patterns.
 *
 * [Engineer-Principal · Opus · run-orbital-review-ui]
 *
 * The hub-side WS supports `story:<id>` patterns (see
 * packages/orchestrator/src/ws/subscriptions.ts). This module exposes a tiny
 * helper that lets a page mount/unmount a per-story subscription without
 * needing direct access to the WebSocket. The actual frame is sent by
 * services/ws.ts which exposes a global `sendSubscribe` hook.
 *
 * If the WS isn't connected (CloudFront-only build, local dev with no hub),
 * these calls are no-ops; the page still works because tRPC polls and the
 * StoryDetail page also invalidates on the events ring.
 */

type SubscribeFrame = {
  type: 'subscribe' | 'unsubscribe'
  patterns: string[]
}

let send: ((frame: SubscribeFrame) => void) | null = null

/**
 * Wire the actual sender. Called by services/ws.ts on connection open.
 * Safe to call multiple times — last wins.
 */
export function registerStorySubSender(fn: (frame: SubscribeFrame) => void): void {
  send = fn
}

/** Add a story:<id> subscription. No-op if the WS isn't ready. */
export function addStorySubscription(storyId: string): void {
  send?.({ type: 'subscribe', patterns: [`story:${storyId}`] })
}

/** Remove a story:<id> subscription. No-op if the WS isn't ready. */
export function removeStorySubscription(storyId: string): void {
  send?.({ type: 'unsubscribe', patterns: [`story:${storyId}`] })
}
