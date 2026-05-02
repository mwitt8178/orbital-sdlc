/**
 * inspection/types.ts — WorkerInspection shape for UI components.
 *
 * Mirrors the backend WorkerInspection type from packages/orchestrator/src/inspection/types.ts.
 * Kept in sync manually — if the backend shape changes, update this too.
 *
 * [Engineer-Sr · Sonnet · run-round6-10-inspection]
 */

export type WorkerState =
  | 'starting'
  | 'briefing'
  | 'running'
  | 'awaiting'
  | 'idle'
  | 'terminating'
  | 'terminated'

export interface WorkerInspection {
  workerId: string
  taskId: string
  ticketId?: string

  persona: { id: string; name: string; tier: string }
  model: { provider: string; model: string }

  state: WorkerState
  startedAt: string
  lastActivityAt: string

  capability: {
    scopes: {
      filesRead: string[]
      filesWrite: string[]
      channelPost: string[]
      [key: string]: string[]
    }
    expiresAt: string
  }

  skillsLoaded: Array<{ id: string; loadedAt: string; sourceSha256: string }>

  recentLLMCalls: Array<{
    llmCallId: string
    startedAt: string
    durationMs?: number
    status: 'pending' | 'ok' | 'err'
    provider: string
    model: string
    inputTokens?: number
    outputTokens?: number
    costUSD?: number
  }>

  recentToolCalls: Array<{
    toolCallId: string
    name: string
    startedAt: string
    durationMs?: number
    status: 'pending' | 'ok' | 'err'
    argsSummary?: string
    resultExcerpt?: string
  }>

  costToDate: { tokens: number; usd: number }
  costBudgetForScope?: { hardCap: number; softThreshold: number; pctUsed: number }

  recentChannelPosts: Array<{ channel: string; bodyExcerpt: string; postedAt: string }>

  outputTail: string[]
}
