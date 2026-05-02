/**
 * vision/pm-stub-subscriber.ts — EventStore subscriber that drives the
 * PM stub response when no real Anthropic worker is available.
 *
 * Rationale for subscriber pattern vs. modifying service.ts directly:
 *   VisionService.sendMessage() already emits VisionMessageSent. Injecting
 *   stub logic into that method would couple the service to dev-mode concerns
 *   and risk conflicting with the Vision/Sprint agent's concurrent work.
 *   A separate subscriber is additive, testable in isolation, and can be
 *   registered / unregistered without touching the core service path.
 *
 * Behaviour:
 *   - Subscribes to all events on the 'vision_document' aggregate.
 *   - On VisionMessageSent with actor.type !== 'persona' (i.e. user messages):
 *     1. Calls isStubMode() — returns true when ANTHROPIC_API_KEY absent or
 *        CLAUDE_BIN not found.
 *     2. If stub mode: counts existing user messages in this session (to
 *        determine which PM script line to use) then calls
 *        VisionPMStub.onMessage() fire-and-forget.
 *   - If stub mode is false (real worker available) the event is ignored and
 *     the real PM worker that VisionService.start enqueued handles the reply.
 *
 * Registration: call registerVisionPMStub({ eventStore, db }) from boot.ts
 * or from the tRPC vision router after the lazy service is built.
 * Returns an unsubscribe function for graceful shutdown.
 */

import { and, eq } from 'drizzle-orm'
import type { EventStore } from '../events/store.js'
import type { DB } from '../db/client.js'
import { visionMessages } from '../db/schema/vision.js'
import { VisionPMStub, isStubMode } from './pm-stub.js'
import { logger } from '../config/logger.js'
import type { VisionSessionId } from './types.js'
import type { AnthropicDriver } from '../personas/anthropic-driver.js'
import { isAnthropicAvailable } from '../personas/anthropic-driver.js'

export interface PMStubDeps {
  eventStore: EventStore
  db: DB
  /**
   * Optional AnthropicDriver. When present and ANTHROPIC_API_KEY is set the
   * stub uses real LLM-backed responses; otherwise it falls back to the
   * deterministic templated path.
   */
  driver?: AnthropicDriver | null
}

/**
 * Register the PM stub EventStore subscriber.
 *
 * Returns an unsubscribe function — call it in shutdown() to clean up.
 */
export function registerVisionPMStub({ eventStore, db, driver = null }: PMStubDeps): () => void {
  const stub = new VisionPMStub(db, eventStore, driver)

  // Three modes determine whether the subscriber should produce a reply:
  //   (a) real Claude CLI worker available  → subscriber stays out (worker spawns)
  //   (b) AnthropicDriver wired + key set    → subscriber drives via driver path
  //   (c) no key / no CLI                    → subscriber drives templated path
  //
  // isStubMode() returns true for (b) AND (c) — i.e. whenever there is no real
  // CLI worker. The stub class itself decides between driver and templated
  // based on whether a driver was injected and whether the call succeeds.
  let _stubModeCache: boolean | null = null

  async function getStubMode(): Promise<boolean> {
    if (_stubModeCache !== null) return _stubModeCache
    _stubModeCache = await isStubMode()
    logger.info(
      {
        stubMode: _stubModeCache,
        driverAvailable: !!driver && isAnthropicAvailable(),
      },
      'pm-stub-subscriber: stub mode resolved',
    )
    return _stubModeCache
  }

  const unsubscribe = eventStore.subscribe(null, (envelope) => {
    if (envelope.event_type !== 'VisionMessageSent') return

    const payload = envelope.payload as Record<string, unknown>
    const authorType = payload['author_type']

    // Only react to user-authored messages — PM replies must not trigger PM
    // replies (infinite loop guard).
    if (authorType !== 'user') return

    const sessionId = payload['vision_session_id'] as VisionSessionId | undefined
    if (!sessionId) return

    // Fire-and-forget: count user messages in this session then dispatch stub
    void (async () => {
      try {
        const inStubMode = await getStubMode()
        if (!inStubMode) return // real PM worker handles it

        // Count existing user messages in this session (the message that just
        // arrived is already persisted, so this count includes it).
        const existingUserMessages = await db
          .select({ id: visionMessages.visionMessageId })
          .from(visionMessages)
          .where(
            and(
              eq(visionMessages.visionSessionId, sessionId),
              eq(visionMessages.authorType, 'user'),
            ),
          )

        const userCount = existingUserMessages.length

        await stub.onMessage(sessionId, userCount)
      } catch (err) {
        logger.error(
          { err, sessionId },
          'pm-stub-subscriber: onMessage threw — ignoring to preserve main flow',
        )
      }
    })()
  })

  logger.info('pm-stub-subscriber: registered')
  return unsubscribe
}
