/**
 * inspection/types.ts — WorkerInspection data shape.
 *
 * This is the instrumentation contract that Wave 3b (#7 replay) depends on.
 * Any changes to this shape must be coordinated with the replay agent.
 *
 * [Engineer-Sr · Sonnet · run-round6-10-inspection]
 */

// ---------------------------------------------------------------------------
// Worker inspection shape
// ---------------------------------------------------------------------------

export interface WorkerInspectionPersona {
  id: string
  name: string
  /** Model tier: 'sonnet' | 'haiku' | 'opus' | 'gpt-4o' | etc. */
  tier: string
}

export interface WorkerInspectionModel {
  provider: string
  model: string
}

export interface WorkerInspectionCapability {
  scopes: {
    filesRead: string[]
    filesWrite: string[]
    channelPost: string[]
    [key: string]: string[]
  }
  expiresAt: string
}

export interface WorkerInspectionSkill {
  id: string
  loadedAt: string
  sourceSha256: string
}

export interface WorkerInspectionLLMCall {
  llmCallId: string
  startedAt: string
  durationMs?: number
  status: 'pending' | 'ok' | 'err'
  provider: string
  model: string
  inputTokens?: number
  outputTokens?: number
  costUSD?: number
}

export interface WorkerInspectionToolCall {
  toolCallId: string
  name: string
  startedAt: string
  durationMs?: number
  status: 'pending' | 'ok' | 'err'
  argsSummary?: string
  resultExcerpt?: string
}

export interface WorkerInspectionCostToDate {
  tokens: number
  usd: number
}

export interface WorkerInspectionBudget {
  hardCap: number
  softThreshold: number
  pctUsed: number
}

export interface WorkerInspectionChannelPost {
  channel: string
  bodyExcerpt: string
  postedAt: string
}

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

  persona: WorkerInspectionPersona
  model: WorkerInspectionModel

  state: WorkerState
  startedAt: string
  lastActivityAt: string

  capability: WorkerInspectionCapability

  skillsLoaded: WorkerInspectionSkill[]

  recentLLMCalls: WorkerInspectionLLMCall[]
  recentToolCalls: WorkerInspectionToolCall[]

  costToDate: WorkerInspectionCostToDate
  costBudgetForScope?: WorkerInspectionBudget

  recentChannelPosts: WorkerInspectionChannelPost[]

  outputTail: string[]
}

// ---------------------------------------------------------------------------
// Worker registration input (supplied at spawn time)
// ---------------------------------------------------------------------------

export interface WorkerRegistrationParams {
  taskId: string
  ticketId?: string
  personaId: string
  personaName: string
  modelProvider: string
  modelId: string
  capabilityScopes: WorkerInspectionCapability['scopes']
  capabilityExpiresAt: string
  startedAt: string
  costBudgetForScope?: WorkerInspectionBudget
}

// ---------------------------------------------------------------------------
// Timeline entry shape
// ---------------------------------------------------------------------------

export interface InspectionTimelineEntry {
  event_id: string
  event_type: string
  aggregate_id: string
  occurred_at: string
  payload: unknown
}
