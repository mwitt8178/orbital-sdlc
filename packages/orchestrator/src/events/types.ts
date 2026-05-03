/**
 * Event type re-exports and internal helpers for the events subsystem.
 *
 * Per Task 1A spec: re-export from @orbital/types; add internal helpers.
 * No new Zod schemas are defined here — canonical shapes live in @orbital/types.
 *
 * Round 6 #8 additions: 5 new provider/routing event payload types.
 */

export type {
  EventEnvelope,
  EventInput,
  EventQueryFilter,
  AggregateType,
  Actor,
} from '@orbital/types'

export {
  EventEnvelopeSchema,
  EventInputSchema,
  EventQueryFilterSchema,
  AggregateTypeSchema,
  ActorSchema,
} from '@orbital/types'

export type { PaginatedResponse } from '@orbital/types'

import { EventEnvelopeSchema } from '@orbital/types'
import type { EventEnvelope } from '@orbital/types'
import type { EventRow } from '../db/schema/events.js'

/**
 * Normalize a timestamp string from Postgres (space-separated, +00) to ISO 8601
 * (T-separated, Z suffix) so Zod's z.string().datetime() accepts it.
 *
 * Postgres returns timestamps in the form "2026-05-01 15:42:18.123+00"
 * ISO 8601 requires "2026-05-01T15:42:18.123Z".
 */
function toIso8601(ts: string): string {
  // Replace the space separator with T, and trailing +00 (with optional :00) with Z.
  return ts.replace(' ', 'T').replace(/\+00(:00)?$/, 'Z')
}

/**
 * Map a raw Drizzle EventRow to a validated EventEnvelope.
 * Throws ZodError if the row does not conform — schema_version included.
 *
 * Per TRD-07 §9 (schema versioning): the envelope is returned with its
 * original schema_version; callers dispatch on that version for payload parsing.
 */
export function rowToEnvelope(row: EventRow): EventEnvelope {
  return EventEnvelopeSchema.parse({
    event_id: row.eventId,
    aggregate_id: row.aggregateId,
    aggregate_type: row.aggregateType,
    event_type: row.eventType,
    payload: row.payload,
    actor: row.actor,
    capability_id: row.capabilityId ?? undefined,
    parent_event_id: row.parentEventId ?? undefined,
    trace_id: row.traceId,
    // Normalize Postgres timestamp format to ISO 8601 for Zod validation.
    occurred_at: toIso8601(row.occurredAt),
    ingested_at: toIso8601(row.ingestedAt),
    schema_version: row.schemaVersion,
  })
}

// ---------------------------------------------------------------------------
// Round 6 #8 — Provider / routing event payload types
// ---------------------------------------------------------------------------

/**
 * Emitted by FallbackDriver after a successful provider call.
 * event_type: 'ProviderCallSucceeded'
 */
export interface ProviderCallSucceededPayload {
  providerId: string
  model: string
  attemptIndex: number
}

/**
 * Emitted by FallbackDriver after a failed provider call.
 * event_type: 'ProviderCallFailed'
 */
export interface ProviderCallFailedPayload {
  providerId: string
  model: string
  attemptIndex: number
  error: string
  retriable: boolean
}

/**
 * Emitted by the circuit breaker when a provider transitions CLOSED → OPEN.
 * event_type: 'ProviderCircuitOpened'
 */
export interface ProviderCircuitOpenedPayload {
  providerId: string
  consecutiveFailures: number
}

/**
 * Emitted by the circuit breaker when a provider transitions OPEN → CLOSED
 * (half-open probe succeeded).
 * event_type: 'ProviderCircuitClosed'
 */
export interface ProviderCircuitClosedPayload {
  providerId: string
}

/**
 * Emitted by RoutingEngine.routeModel() for every routing decision.
 * event_type: 'ModelRoutingDecided'
 */
export interface ModelRoutingDecidedPayload {
  persona: string
  estimate: string
  provider: string
  model: string
  sod_applied: boolean
  reason: string
  author_provider?: string
  author_model?: string
}

// ---------------------------------------------------------------------------
// Round 6 #1 — GitHub PR loop event payload types
// [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
// ---------------------------------------------------------------------------

/**
 * Emitted after a git push of the agent branch succeeds.
 * event_type: 'BranchPushed'
 */
export interface BranchPushedPayload {
  task_id: string
  branch: string
  head_sha: string
}

/**
 * Emitted after GitHub PR is opened successfully.
 * event_type: 'PROpened'
 */
export interface PROpenedPayload {
  task_id: string
  pr_number: number
  html_url: string
  owner: string
  repo: string
  branch: string
  head_sha?: string
}

/**
 * Emitted by webhook handler when a PR is merged via GitHub.
 * event_type: 'PRMerged'
 */
export interface PRMergedPayload {
  task_id: string
  pr_number: number
  merged_at: string
  merge_sha?: string
}

/**
 * Emitted by webhook handler when a PR is closed without merging.
 * event_type: 'PRClosed'
 */
export interface PRClosedPayload {
  task_id: string
  pr_number: number
  closed_at: string
}

// ---------------------------------------------------------------------------
// Round 6 #10 — Live Operator Inspection Layer event payload types
// [Engineer-Sr · Sonnet · run-round6-10-inspection]
// ---------------------------------------------------------------------------

/**
 * Emitted by mcp/gateway.ts BEFORE a tool call is invoked.
 * event_type: 'ToolCallStarted'
 */
export interface ToolCallStartedPayload {
  worker_id: string
  /** Unique id for this call (correlates Started ↔ Completed). */
  tool_call_id: string
  tool_name: string
  /** Short summary of args (truncated at 200 chars). */
  args_summary: string
  started_at: string
}

/**
 * Emitted by mcp/gateway.ts AFTER a tool call completes (both ok and err paths).
 * event_type: 'ToolCallCompleted'
 */
export interface ToolCallCompletedPayload {
  worker_id: string
  tool_call_id: string
  tool_name: string
  status: 'ok' | 'err'
  duration_ms: number
  /** First 200 chars of the result or error message. */
  result_excerpt: string
  completed_at: string
}

/**
 * Emitted by personas/anthropic-driver.ts BEFORE an LLM call.
 * event_type: 'LLMRequestStarted'
 */
export interface LLMRequestStartedPayload {
  worker_id: string
  /** Correlates Started ↔ Completed. */
  llm_call_id: string
  provider: string
  model: string
  started_at: string
}

/**
 * Emitted by personas/anthropic-driver.ts AFTER an LLM call (both paths).
 * event_type: 'LLMRequestCompleted'
 */
export interface LLMRequestCompletedPayload {
  worker_id: string
  llm_call_id: string
  provider: string
  model: string
  status: 'ok' | 'err'
  duration_ms: number
  input_tokens?: number
  output_tokens?: number
  cost_usd?: number
  completed_at: string
}

/**
 * Emitted by personas/skill-loader.ts once per skill bundled for a worker.
 * event_type: 'SkillLoaded'
 */
export interface SkillLoadedPayload {
  worker_id: string
  skill_id: string
  loaded_at: string
  source_sha256: string
}

/**
 * Emitted by orchestration/spawn.ts on major lifecycle transitions.
 * event_type: 'WorkerLifecyclePhase'
 */
export interface WorkerLifecyclePhasePayload {
  worker_id: string
  phase: 'briefing' | 'running' | 'awaiting' | 'idle' | 'terminating' | 'terminated'
  occurred_at: string
}

/**
 * Emitted when an operator kills a worker via admin.workers.kill.
 * event_type: 'WorkerKilledByOperator'
 */
export interface WorkerKilledByOperatorPayload {
  worker_id: string
  operator_id: string
  reason: string
  killed_at: string
}

// ---------------------------------------------------------------------------
// Round 6 #6 — CI/CD Bridge event payload types
// [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
// ---------------------------------------------------------------------------

/**
 * Emitted when a CI check_run or workflow_run begins on the PR head SHA.
 * event_type: 'CIRunStarted'
 */
export interface CIRunStartedPayload {
  task_id: string
  pr_number: number
  ci_check_name: string
  ci_run_url: string
  head_sha: string
  started_at: string
  /** 'check_run' | 'workflow_run' */
  source: string
}

/**
 * Emitted when a CI check_run or workflow_run completes with a passing conclusion.
 * event_type: 'CIRunCompleted'
 */
export interface CIRunCompletedPayload {
  task_id: string
  pr_number: number
  ci_check_name: string
  ci_run_url: string
  ci_conclusion: string
  head_sha: string
  started_at: string
  completed_at: string
  duration_ms: number
  /** 'check_run' | 'workflow_run' */
  source: string
}

/**
 * Emitted when a CI check_run or workflow_run completes with a failing conclusion.
 * event_type: 'CIRunFailed'
 */
export interface CIRunFailedPayload {
  task_id: string
  pr_number: number
  ci_check_name: string
  ci_run_url: string
  ci_conclusion: string
  head_sha: string
  started_at: string
  completed_at: string
  duration_ms: number
  /** 'check_run' | 'workflow_run' */
  source: string
}

// ---------------------------------------------------------------------------
// Round 6 #7 — Determinism / Replay event payload types
// [Engineer-Principal · Opus · run-round6-07-replay]
// ---------------------------------------------------------------------------

/**
 * Emitted by Recorder.capture(...) BEFORE the blob is persisted.
 * event_type: 'ReplayCaptureStarted'
 *
 * Useful for ops dashboards that want to show "capture in progress" state.
 * Most consumers will only need ReplayCaptureCompleted.
 */
export interface ReplayCaptureStartedPayload {
  capture_id: string
  worker_id: string | null
  task_id: string | null
  event_id: string | null
  capture_kind: 'llm_request' | 'tool_call' | 'hook_invocation'
  provider?: string
  model?: string
  started_at: string
}

/**
 * Emitted by Recorder.capture(...) AFTER the blob is durably persisted and
 * the metadata row is written.
 * event_type: 'ReplayCaptureCompleted'
 */
export interface ReplayCaptureCompletedPayload {
  capture_id: string
  worker_id: string | null
  task_id: string | null
  event_id: string | null
  capture_kind: 'llm_request' | 'tool_call' | 'hook_invocation'
  provider?: string
  model?: string
  request_hash: string
  response_hash: string
  storage_uri: string
  size_bytes: number
  completed_at: string
}

/**
 * Emitted by Player.replay(...) on every replay invocation (any mode).
 * event_type: 'ReplayPlayed'
 */
export interface ReplayPlayedPayload {
  capture_id: string
  mode: 'inspect' | 'replay-substituted' | 'replay-live'
  /** True when the replayed result matches the recorded response_hash. */
  matched_hash: boolean
  /** Duration of the replay execution in ms. */
  duration_ms: number
  played_at: string
}

/**
 * Emitted when the on-disk blob fails the integrity hash check on read,
 * or cannot be decrypted.
 * event_type: 'ReplayCorrupt'
 */
export interface ReplayCorruptPayload {
  capture_id: string
  storage_uri: string
  /** Why the blob is considered corrupt. */
  reason: string
  detected_at: string
}

// ---------------------------------------------------------------------------
// Round 6 #5 — Cost Governance event payload types
// [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
// ---------------------------------------------------------------------------

/**
 * Emitted by CostService.appendLedger after each LLM call is persisted.
 * Subscribed by the TopBar live-burn widget via WS.
 * event_type: 'CostLedgerAppended'
 */
export interface CostLedgerAppendedPayload {
  entry_id:          string
  project_id:        string
  sprint_id:         string | null
  task_id:           string | null
  worker_id:         string | null
  persona_id:        string | null
  model:             string
  provider:          string
  input_tokens:      number
  output_tokens:     number
  cache_read_tokens: number
  cache_write_tokens: number
  cost_usd:          number
  occurred_at:       string
}

/**
 * Emitted by CostEnforcer when running + estimated cost exceeds the hard cap,
 * preventing a spawn from proceeding.
 * event_type: 'BudgetExceeded'
 */
export interface BudgetExceededPayload {
  scope:            string
  scope_id:         string
  running_cost_usd: number
  hard_cap_usd:     number
  occurred_at:      string
}

/**
 * Emitted when a scope is auto-paused due to budget ceiling breach.
 * event_type: 'BudgetPaused'
 */
export interface BudgetPausedPayload {
  scope:       string
  scope_id:    string
  reason:      string
  paused_at:   string
}

/**
 * Emitted when a budget-paused scope is manually resumed by an operator.
 * event_type: 'BudgetResumed'
 */
export interface BudgetResumedPayload {
  scope:       string
  scope_id:    string
  resumed_by:  string
  resumed_at:  string
}

/**
 * Emitted per worker when the kill switch is tripped (auto or operator-initiated).
 * event_type: 'KillSwitchTripped'
 */
export interface KillSwitchTrippedPayload {
  worker_id: string
  scope:     string
  scope_id:  string
  reason:    string
  actor_id:  string
  killed_at: string
}

// ---------------------------------------------------------------------------
// Round 6 #3 — Iterate-on-Defect Loop event payload types
// [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
// ---------------------------------------------------------------------------

/**
 * Emitted by DefectService.submitDefect when an operator reports a defect
 * against a specific AC.
 * event_type: 'DefectReported'
 */
export interface DefectReportedPayload {
  defect_id: string
  task_id: string
  ac_id: string
  ac_text: string
  severity: 'low' | 'medium' | 'high' | 'critical'
  reproduction_steps: string
  suggested_fix?: string
  reported_by: string
  reported_at: string
}

/**
 * Emitted by post-defect-reported hook when an author task is re-opened
 * to begin a new iteration.
 * event_type: 'TaskReopenedForDefect'
 */
export interface TaskReopenedForDefectPayload {
  task_id: string
  defect_id: string
  iteration_count: number
  reopened_at: string
}

/**
 * Emitted when a defect-driven iteration begins (task transitions to in_progress).
 * event_type: 'IterationStarted'
 */
export interface IterationStartedPayload {
  task_id: string
  defect_id: string
  iteration_number: number
  started_at: string
}

/**
 * Emitted when a defect-driven iteration completes (verifier passed).
 * event_type: 'IterationCompleted'
 */
export interface IterationCompletedPayload {
  task_id: string
  defect_id: string
  iteration_number: number
  head_sha?: string
  completed_at: string
}

/**
 * Emitted when an operator reports the 4th defect on a task that has already
 * reached 3 iterations. System does NOT re-spawn; human escalation required.
 * event_type: 'DefectIterationLimitReached'
 */
export interface DefectIterationLimitReachedPayload {
  task_id: string
  defect_id: string
  iteration_count: number
  limit: number
  reported_at: string
}

/**
 * Emitted when an operator marks a defect as resolved (verified by re-run UAT).
 * event_type: 'DefectResolved'
 */
export interface DefectResolvedPayload {
  defect_id: string
  task_id: string
  resolved_by: string
  resolved_at: string
}

/**
 * Emitted after a force-with-lease push of a defect-iteration branch update
 * (the branch already exists; this is a re-push, not first push).
 * event_type: 'BranchUpdated'
 */
export interface BranchUpdatedPayload {
  task_id: string
  branch: string
  head_sha: string
  iteration_number: number
  updated_at: string
}

/**
 * Emitted by UATService when ALL ACs pass on a UAT session AND the parent task
 * has iteration_count > 0 (meaning at least one defect-driven iteration occurred).
 * Signals that the defect loop closed successfully.
 * event_type: 'UATResolutionVerified'
 * aggregate_type: 'task', aggregate_id: task_id
 */
export interface UATResolutionVerifiedPayload {
  task_id: string
  ticket_id: string
  uat_session_id: string
  total_iterations: number
  total_defects_filed: number
  total_defects_resolved: number
  finalized_at: string
}

// ---------------------------------------------------------------------------
// Round 6 #2 — Code-Review Persona + Agent-to-Agent Review Loop
// [Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]
// ---------------------------------------------------------------------------

/**
 * Emitted when the reviewer task begins its review of a PR.
 * event_type: 'CodeReviewStarted'
 * aggregate_type: 'task', aggregate_id: author_task_id
 */
export interface CodeReviewStartedPayload {
  /** The author task whose PR is being reviewed. */
  author_task_id: string
  /** The reviewer child task performing the review. */
  reviewer_task_id: string
  /** GitHub PR number. */
  pr_number: number
  /** Reviewer persona slug (e.g. "reviewer"). */
  reviewer_persona_id: string
  started_at: string
}

/**
 * Emitted when the reviewer submits a review to GitHub.
 * event_type: 'CodeReviewSubmitted'
 * aggregate_type: 'task', aggregate_id: author_task_id
 */
export interface CodeReviewSubmittedPayload {
  /** Primary key of the code_reviews row. */
  review_id: string
  /** The author task whose PR was reviewed. */
  author_task_id: string
  /** The reviewer child task that performed the review. */
  reviewer_task_id: string
  /** GitHub PR number. */
  pr_number: number
  /** Reviewer persona slug. */
  reviewer_persona_id: string
  /**
   * Review state submitted to GitHub.
   * APPROVED | CHANGES_REQUESTED | COMMENTED
   */
  state: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED'
  /** Number of inline file:line comments. */
  comments_count: number
  /** Review body summary. */
  body: string
  submitted_at: string
}

/**
 * Emitted after a CHANGES_REQUESTED review causes the author task to be
 * reopened with the reviewer's feedback appended.
 * event_type: 'CodeReviewIterationRequested'
 * aggregate_type: 'task', aggregate_id: author_task_id
 */
export interface CodeReviewIterationRequestedPayload {
  /** The review that triggered the iteration. */
  review_id: string
  /** The author task being re-queued. */
  author_task_id: string
  /** The reviewer task that requested changes. */
  reviewer_task_id: string
  /** GitHub PR number. */
  pr_number: number
  /** Feedback appended to the author task description. */
  feedback_summary: string
  requested_at: string
}

// ---------------------------------------------------------------------------
// Round 6 #9 — Inter-Agent Channel Collaboration event payload types
// [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
// ---------------------------------------------------------------------------

/**
 * Emitted by ChannelsService.post when the author actor is type 'persona'.
 * Used by the UI Channels page "Agent activity" tab and AgentTalkView.
 * event_type: 'AgentChannelPosted'
 * aggregate_type: 'channel_post', aggregate_id: post_id
 */
export interface AgentChannelPostedPayload {
  /** ID of the channel post row. */
  post_id: string
  /** ID of the channel the message was posted to. */
  channel_id: string
  /** Channel name (e.g. '#escalation-sprint-id'). */
  channel_name: string
  /** The persona that posted. */
  persona_id: string
  /** The worker session that posted (for cost attribution). */
  session_id: string
  /** The task this worker is assigned to, if any. */
  task_id: string | null
  /** Sprint ID this post is associated with (from cross_references or derived). */
  sprint_id: string | null
  /** post_type from channel_posts table. */
  post_type: string
  /** Truncated body of the message (first 500 chars). */
  body_excerpt: string
  /** Cost of the LLM call that produced this post, in USD (0 if unknown). */
  cost_usd: number
  /** Model used for the LLM call that produced this post (empty string if unknown). */
  model: string
  posted_at: string
}

/**
 * Emitted by the post-escalation-raised hook when a persona posts to an
 * escalation channel, indicating this worker needs help from a senior persona.
 * event_type: 'EscalationRaised'
 * aggregate_type: 'task', aggregate_id: source_task_id
 */
export interface EscalationRaisedPayload {
  /** ID of the channel post that triggered the escalation. */
  post_id: string
  /** ID of the task that is being escalated. */
  source_task_id: string
  /** Sprint ID the task belongs to. */
  sprint_id: string
  /** Persona hint for the child task the scheduler should spawn. */
  target_persona_hint: string
  /** The persona that raised the escalation. */
  raised_by_persona: string
  /** Escalation reason extracted from post payload. */
  reason: string
  /** Confidence score at time of escalation (0-100), -1 if unknown. */
  confidence: number
  raised_at: string
}

/**
 * Emitted by the post-handoff-requested hook when a persona posts a handoff_note,
 * requesting the scheduler to create a child task for a different bounded context.
 * event_type: 'HandOffRequested'
 * aggregate_type: 'task', aggregate_id: source_task_id
 */
export interface HandOffRequestedPayload {
  /** ID of the channel post containing the handoff_note. */
  post_id: string
  /** ID of the task requesting the hand-off. */
  source_task_id: string
  /** Sprint ID the task belongs to. */
  sprint_id: string
  /** Target persona slug for the child task. */
  target_persona: string
  /** Human-readable reason for the hand-off. */
  handoff_reason: string
  /** Short title for the child task. */
  suggested_title: string
  /** Longer context/description for the child task. */
  suggested_description: string
  requested_at: string
}

/**
 * Emitted when a persona posts a peer_question to #orb-engineering.
 * No scheduler action — this is informational only; a senior persona
 * may reply in-channel without spawning a new task.
 * event_type: 'PeerHelpRequested'
 * aggregate_type: 'channel_post', aggregate_id: post_id
 */
export interface PeerHelpRequestedPayload {
  /** ID of the channel post containing the peer_question. */
  post_id: string
  /** Channel ID (will always be the #orb-engineering channel). */
  channel_id: string
  /** Persona asking for help. */
  asking_persona: string
  /** Task the asking persona is assigned to. */
  task_id: string | null
  /** Truncated question body. */
  question_excerpt: string
  posted_at: string
}

// ---------------------------------------------------------------------------
// Round 9 — Onboarding UX Overhaul event payload types
// [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
// ---------------------------------------------------------------------------

/**
 * Emitted when an operator opens the welcome screen and picks a flow card.
 * event_type: 'OnboardingStarted'
 * aggregate_type: 'install', aggregate_id: install_id
 */
export interface OnboardingStartedPayload {
  session_id: string
  install_id: string
  flow: 'new_project' | 'existing_repo' | 'join_hub' | 'sample_data'
  started_at: string
}

/**
 * Emitted after the Monday board (with full SDLC column set) has been created
 * via Monday API for a new project.
 * event_type: 'MondayBoardProvisioned'
 * aggregate_type: 'install', aggregate_id: project_id
 */
export interface MondayBoardProvisionedPayload {
  session_id: string
  project_id: string
  monday_board_id: string
  monday_board_url: string
  workspace_id: string | null
  /** Number of canonical columns added to the board. */
  columns_added: number
  /** Number of workflow status values configured. */
  status_values_added: number
  /** Whether mapping_json was written (true == personas can use this board). */
  mapping_persisted: boolean
  provisioned_at: string
}

/**
 * Emitted after the GitHub repo + initial CI workflow + first commit have
 * been created via the GitHub API for a new project.
 * event_type: 'GitRepoProvisioned'
 * aggregate_type: 'install', aggregate_id: project_id
 */
export interface GitRepoProvisionedPayload {
  session_id: string
  project_id: string
  owner: string
  repo: string
  html_url: string
  default_branch: string
  is_private: boolean
  /** Whether the CI workflow file was committed. */
  ci_workflow_committed: boolean
  /** Whether the webhook was successfully registered. */
  webhook_configured: boolean
  /** Labels created on the repo (enhancement / bug / etc.). */
  labels_created: string[]
  provisioned_at: string
}

/**
 * Emitted after Flow B's codebase analyzer has run (static + optional LLM).
 * event_type: 'CodebaseAnalyzed'
 * aggregate_type: 'install', aggregate_id: project_id
 */
export interface CodebaseAnalyzedPayload {
  session_id: string
  project_id: string
  owner: string
  repo: string
  /** Detected stack labels (e.g. ['nodejs','typescript','react','tailwind']). */
  stack: string[]
  /** Detected test runner if any. */
  test_runner: string | null
  /** Detected commit-message convention. */
  commit_convention: string | null
  /** Detected branch model. */
  branch_model: string | null
  /** Number of CI workflows seen in .github/workflows. */
  ci_workflow_count: number
  /** Number of memory entries the seeder will create from this analysis. */
  memory_entries_inferred: number
  /** Whether the LLM-assisted step was opted into. */
  llm_used: boolean
  /** Approximate spend (USD) of the LLM step. 0 if not used. */
  llm_cost_usd: number
  analyzed_at: string
}

/**
 * Emitted after the system-teaching step finishes — project CLAUDE.md
 * generated, project memory seeded, persona-brief project context wired,
 * skill bundle config written.
 * event_type: 'ProjectSDLCConfigured'
 * aggregate_type: 'install', aggregate_id: project_id
 */
export interface ProjectSDLCConfiguredPayload {
  session_id: string
  project_id: string
  /** Whether project CLAUDE.md was committed to the repo. */
  claude_md_committed: boolean
  /** SHA of the commit that added CLAUDE.md, if any. */
  claude_md_sha: string | null
  /** Number of memory entries seeded by the seeder. */
  memory_entries_seeded: number
  /** Skills enabled for this project (from skills.json). */
  skills_enabled: string[]
  configured_at: string
}

/**
 * Emitted when the wizard runs through to "Done". Carries time-per-step + any
 * step abandonments for telemetry.
 * event_type: 'OnboardingCompleted'
 * aggregate_type: 'install', aggregate_id: install_id
 */
export interface OnboardingCompletedPayload {
  session_id: string
  install_id: string
  project_id: string | null
  flow: 'new_project' | 'existing_repo' | 'join_hub' | 'sample_data'
  /** Map of step_id → ms-on-task. */
  step_durations: Record<string, number>
  /** Total wall-clock duration (ms) from session start to complete. */
  total_duration_ms: number
  completed_at: string
}

/**
 * Emitted when the wizard is abandoned (user navigates away or explicitly
 * cancels). Helps the team understand drop-off per step.
 * event_type: 'OnboardingAbandoned'
 * aggregate_type: 'install', aggregate_id: install_id
 */
export interface OnboardingAbandonedPayload {
  session_id: string
  install_id: string
  flow: 'new_project' | 'existing_repo' | 'join_hub' | 'sample_data'
  /** Last step the user was on before abandoning. */
  last_step: string
  /** Reason if explicitly cancelled. 'navigated_away' if implicit. */
  reason: string
  step_durations: Record<string, number>
  abandoned_at: string
}

// ---------------------------------------------------------------------------
// Cursor helpers
// ---------------------------------------------------------------------------

/**
 * Encode a cursor from (occurred_at, event_id) for paginating the events query.
 * Cursor is base64url so it survives URL transmission.
 * Per TRD-07 §6.1.1 cursor semantics.
 */
export function encodeCursor(occurredAt: string, eventId: string): string {
  return Buffer.from(JSON.stringify({ occurred_at: occurredAt, event_id: eventId })).toString(
    'base64url',
  )
}

export interface DecodedCursor {
  occurred_at: string
  event_id: string
}

/**
 * Decode a cursor. Returns null if the cursor is null/empty (start of list).
 * Throws if the cursor is malformed.
 */
export function decodeCursor(cursor: string | null | undefined): DecodedCursor | null {
  if (!cursor) return null
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)['occurred_at'] !== 'string' ||
      typeof (parsed as Record<string, unknown>)['event_id'] !== 'string'
    ) {
      throw new Error('invalid cursor shape')
    }
    return parsed as DecodedCursor
  } catch {
    throw new Error(`VALIDATION_INVALID_CURSOR: malformed cursor`)
  }
}
