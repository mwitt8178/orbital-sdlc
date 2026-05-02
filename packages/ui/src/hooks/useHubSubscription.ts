/**
 * hooks/useHubSubscription.ts — React hook for hub WS event subscriptions.
 *
 * Round 7-04 — Real-Time Push From Hub To Clients
 * [Engineer-Sr · Sonnet · run-round7-04-realtime-push]
 *
 * Usage:
 *   useHubSubscription('task:abc-123', (event) => {
 *     queryClient.invalidateQueries({ queryKey: ['task', 'abc-123'] })
 *   })
 *
 * Lifecycle:
 *   - Subscribes to the hub WS on mount (sends subscribe message).
 *   - Calls onEvent for every matching event received.
 *   - Re-subscribes automatically after WS reconnect.
 *   - Unsubscribes on unmount (sends unsubscribe message).
 *
 * The hook reads from the hub WS context (HubWsContext) which is populated
 * by the HubWsProvider wrapper in App.tsx. When no hub is configured,
 * the hook is a no-op.
 *
 * React Query invalidation:
 *   Pass a queryClient and queryKey via the options if you want automatic
 *   React Query cache invalidation on event receipt.
 */

import { useEffect, useRef, useCallback } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useHubWsStore } from '../store/hubWs.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type HubEventPayload = Record<string, unknown>

export interface HubSubscriptionEvent {
  event_id: string
  event_type: string
  aggregate_type: string
  aggregate_id: string
  payload: HubEventPayload
  occurred_at: string
  tenant_id?: string
}

export type HubEventHandler = (event: HubSubscriptionEvent) => void

export interface UseHubSubscriptionOptions {
  /**
   * React Query key(s) to invalidate when an event is received.
   * Pass an array of query key arrays: [['tasks', id], ['sprint', sprintId]]
   */
  invalidateKeys?: unknown[][]
  /**
   * Whether the subscription is active. Default true.
   * Set to false to temporarily pause receiving events without unmounting.
   */
  enabled?: boolean
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * useHubSubscription — subscribe to a hub WS pattern.
 *
 * @param pattern  Subscription pattern: 'task:<id>', 'channel:<name>',
 *                 'project:<id>:events', 'worker:<install_id>:*', 'team:presence'
 * @param onEvent  Called for each matching event.
 * @param options  Optional: invalidateKeys, enabled.
 */
export function useHubSubscription(
  pattern: string,
  onEvent: HubEventHandler,
  options: UseHubSubscriptionOptions = {},
): void {
  const { invalidateKeys = [], enabled = true } = options
  const queryClient = useQueryClient()
  const subscribe = useHubWsStore((s) => s.subscribe)
  const unsubscribe = useHubWsStore((s) => s.unsubscribe)

  // Stable callback ref — avoids re-subscribing when onEvent identity changes
  const onEventRef = useRef<HubEventHandler>(onEvent)
  useEffect(() => {
    onEventRef.current = onEvent
  })

  // Stable handler that wraps the ref
  const stableHandler = useCallback(
    (event: HubSubscriptionEvent) => {
      onEventRef.current(event)

      // React Query invalidation
      if (invalidateKeys.length > 0) {
        for (const key of invalidateKeys) {
          void queryClient.invalidateQueries({ queryKey: key })
        }
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [queryClient, ...invalidateKeys.map((k) => JSON.stringify(k))],
  )

  useEffect(() => {
    if (!enabled || !pattern) return
    subscribe(pattern, stableHandler)
    return () => {
      unsubscribe(pattern, stableHandler)
    }
  }, [pattern, enabled, subscribe, unsubscribe, stableHandler])
}
