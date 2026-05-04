/**
 * story-executor-bridge.ts — daemon-side adapter into @orbital/story-executor.
 *
 * The daemon receives `story.ready` events from SQS and must drive a real
 * worker. story-executor is plain ESM JS, so we use a dynamic import and
 * narrow the surface we use.
 *
 * Each invocation runs in a per-run worktree under /tmp/orbital-runs/<run_id>
 * so concurrent stories are filesystem-isolated.
 */

import { ulid } from 'ulid'
import type { Logger } from 'pino'

interface StoryReadyEvent {
  readonly kind: 'story.ready'
  readonly storyId: string
  readonly title: string
  readonly description?: string
  readonly persona?: string
  readonly repoOwner?: string
  readonly repoName?: string
  readonly base?: string
  readonly tenant_id?: string
}

export function isStoryReadyEvent(e: unknown): e is StoryReadyEvent {
  return (
    typeof e === 'object' &&
    e !== null &&
    (e as { kind?: unknown }).kind === 'story.ready' &&
    typeof (e as { storyId?: unknown }).storyId === 'string' &&
    typeof (e as { title?: unknown }).title === 'string'
  )
}

/**
 * Import the story-executor's executeStory function lazily; it pulls in the
 * Anthropic SDK and Postgres pool, neither of which the daemon needs in its
 * boot path.
 */
async function loadExecutor(): Promise<{
  executeStory: (
    story: { storyId: string; title: string; description: string; status: string },
    opts: Record<string, unknown>,
  ) => Promise<{ storyStatus: string; reason: string; lastRunId?: string; pr_url?: string }>
  registerStory: (s: {
    storyId: string
    title: string
    description: string
    status?: string
  }) => { storyId: string; title: string; description: string; status: string }
}> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod = (await import('@orbital/story-executor/src/main.js')) as any
  return { executeStory: mod.executeStory, registerStory: mod.registerStory }
}

/**
 * Dispatch a story.ready event to a real executor run.
 */
export async function handleStoryReady(
  event: StoryReadyEvent,
  logger: Logger,
): Promise<{ runId: string; storyStatus: string; reason: string; pr_url?: string }> {
  const runId = ulid()
  const tenant_id = event.tenant_id ?? 'system'
  const persona = event.persona ?? 'engineer-sr'
  const log = logger.child({ tenant_id, runId, storyId: event.storyId, persona })

  log.info({ event: 'story_ready_dispatch' }, 'daemon: dispatching story.ready to executor')

  const { executeStory, registerStory } = await loadExecutor()
  registerStory({
    storyId: event.storyId,
    title: event.title,
    description: event.description ?? '',
    status: 'ready',
  })

  const t0 = Date.now()
  const result = await executeStory(
    {
      storyId: event.storyId,
      title: event.title,
      description: event.description ?? '',
      status: 'ready',
    },
    {
      mode: 'real-sdk',
      persona,
      repoOwner: event.repoOwner,
      repoName: event.repoName,
      base: event.base ?? 'main',
    },
  )

  log.info(
    {
      event: 'story_ready_completed',
      elapsed_ms: Date.now() - t0,
      story_status: result.storyStatus,
      reason: result.reason,
      pr_url: result.pr_url,
      runId: result.lastRunId ?? runId,
    },
    'daemon: executor finished',
  )

  return {
    runId: result.lastRunId ?? runId,
    storyStatus: result.storyStatus,
    reason: result.reason,
    pr_url: result.pr_url,
  }
}
