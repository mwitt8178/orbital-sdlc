/**
 * backlog/types.ts — Shared types for the backlog + sprint subsystem.
 *
 * Per TRD-02 v0.2 §5 and §6.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Re-export Drizzle row/insert types
// ---------------------------------------------------------------------------

export type {
  EpicRow,
  EpicInsert,
  StoryRow,
  StoryInsert,
  StoryAcceptanceCriterionRow,
  StoryAcceptanceCriterionInsert,
  SprintRow,
  SprintInsert,
  SprintCommitmentRow,
  SprintCommitmentInsert,
  MondaySyncStateRow,
  MondaySyncStateInsert,
  EpicStatus,
  StoryStatus,
  SprintStatus,
  SprintPriorityClass,
  MondayAggregateType,
  SprintPauseState,
} from '@orbital/db'

// ---------------------------------------------------------------------------
// Story state-machine map (per TRD-02 §7.1)
// ---------------------------------------------------------------------------

import type { StoryStatus, SprintStatus } from '@orbital/db'

const STORY_TRANSITIONS: Record<StoryStatus, StoryStatus[]> = {
  backlog: ['ready'],
  ready: ['in_progress', 'blocked'],
  in_progress: ['in_review', 'blocked'],
  in_review: ['done'],
  done: ['accepted', 'defective'],
  accepted: [],
  blocked: ['in_progress', 'ready'],
  defective: ['backlog'],
  // Terminal state per migration 0016 hygiene-sweep semantics: rows enter
  // `cancelled` via a dedicated admin path (not a normal user transition) and
  // do not transition out (audit trail preserved).
  cancelled: [],
}

export function isValidStoryTransition(from: StoryStatus, to: StoryStatus): boolean {
  return (STORY_TRANSITIONS[from] ?? []).includes(to)
}

// ---------------------------------------------------------------------------
// Sprint state-machine map (per TRD-02 §7.2)
// ---------------------------------------------------------------------------

const SPRINT_TRANSITIONS: Record<SprintStatus, SprintStatus[]> = {
  planning: ['ready'],
  ready: ['active'],
  active: ['completing', 'paused'],
  completing: ['completed'],
  completed: [],
  paused: ['active', 'completed'],
}

export function isValidSprintTransition(from: SprintStatus, to: SprintStatus): boolean {
  return (SPRINT_TRANSITIONS[from] ?? []).includes(to)
}

// ---------------------------------------------------------------------------
// API input/output schemas
// ---------------------------------------------------------------------------

export const AcceptanceCriterionInputSchema = z.object({
  text: z.string().min(1),
  verifier_hint: z.string().optional(),
})
export type AcceptanceCriterionInput = z.infer<typeof AcceptanceCriterionInputSchema>

export const CreateEpicInputSchema = z.object({
  vision_version_id: z.string().uuid(),
  title: z.string().min(1),
  rationale: z.string().min(1),
  priority: z.number().int(),
})
export type CreateEpicInput = z.infer<typeof CreateEpicInputSchema>

export const CreateStoryInputSchema = z.object({
  epic_id: z.string().uuid(),
  title: z.string().min(1),
  description: z.string().min(1),
  acceptance_criteria: z.array(AcceptanceCriterionInputSchema).min(1),
  persona_of_record: z.string().optional(),
  origin_story_id: z.string().uuid().optional(),
  defect_id: z.string().uuid().optional(),
  priority: z.number().int().optional(),
})
export type CreateStoryInput = z.infer<typeof CreateStoryInputSchema>

export const UpdateStoryInputSchema = z.object({
  story_id: z.string().uuid(),
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  story_points: z.number().int().positive().optional(),
  status: z
    .enum([
      'backlog',
      'ready',
      'in_progress',
      'in_review',
      'done',
      'accepted',
      'blocked',
      'defective',
    ])
    .optional(),
  reason: z.string().optional(),
  linked_artifacts: z
    .array(
      z.object({
        type: z.string(),
        id: z.string(),
        url: z.string().url().optional(),
      }),
    )
    .optional(),
  persona_of_record: z.string().optional(),
})
export type UpdateStoryInput = z.infer<typeof UpdateStoryInputSchema>

export const PrioritizeStoryInputSchema = z.object({
  story_id: z.string().uuid(),
  position: z.number().int().nonnegative(),
})
export type PrioritizeStoryInput = z.infer<typeof PrioritizeStoryInputSchema>

export const CreateSprintInputSchema = z.object({
  name: z.string().min(1),
  story_point_capacity: z.number().int().positive(),
  budget_usd_cents: z.number().int().positive(),
  wall_clock_target_ms: z.number().int().positive().optional(),
  concurrency_share: z.number().int().positive().optional(),
  priority_class: z.enum(['critical', 'standard', 'background']).optional(),
})
export type CreateSprintInput = z.infer<typeof CreateSprintInputSchema>

export const SprintCommitmentInputSchema = z.object({
  sprint_id: z.string().uuid(),
  selected_story_ids: z.array(z.string().uuid()).min(1),
  capacity_used_points: z.number().int().nonnegative(),
  ceremony_id: z.string().uuid().optional(),
  identified_risks: z
    .array(
      z.object({
        risk: z.string(),
        severity: z.enum(['low', 'medium', 'high']),
        mitigation: z.string().nullable(),
      }),
    )
    .optional(),
  raised_concerns: z
    .array(
      z.object({
        raisedBy: z.string(),
        concern: z.string(),
        disposition: z.enum(['accepted', 'deferred', 'rejected']),
        rationale: z.string(),
      }),
    )
    .optional(),
  is_partial: z.boolean().optional(),
})
export type SprintCommitmentInput = z.infer<typeof SprintCommitmentInputSchema>

// ---------------------------------------------------------------------------
// Error codes (TRD-02 §9)
// ---------------------------------------------------------------------------

export const BACKLOG_ERROR_CODES = {
  VALIDATION_REQUIRED_FIELD_MISSING: 'VALIDATION_REQUIRED_FIELD_MISSING',
  VALIDATION_LINKED_ARTIFACT_MISSING: 'VALIDATION_LINKED_ARTIFACT_MISSING',
  VALIDATION_AC_TEXT_EMPTY: 'VALIDATION_AC_TEXT_EMPTY',
  VALIDATION_CAPACITY_NEGATIVE: 'VALIDATION_CAPACITY_NEGATIVE',
  NOT_FOUND_EPIC: 'NOT_FOUND_EPIC',
  NOT_FOUND_STORY: 'NOT_FOUND_STORY',
  NOT_FOUND_SPRINT: 'NOT_FOUND_SPRINT',
  NOT_FOUND_TICKET: 'NOT_FOUND_TICKET',
  CONFLICT_INVALID_STATE_TRANSITION: 'CONFLICT_INVALID_STATE_TRANSITION',
  CONFLICT_SPRINT_CEILING_EXCEEDED: 'CONFLICT_SPRINT_CEILING_EXCEEDED',
  CONFLICT_STORY_IN_ACTIVE_SPRINT: 'CONFLICT_STORY_IN_ACTIVE_SPRINT',
  CONFLICT_NO_COMMITMENT: 'CONFLICT_NO_COMMITMENT',
  BUDGET_SPRINT_EXCEEDED: 'BUDGET_SPRINT_EXCEEDED',
  INTEGRATION_MONDAY_DOWN: 'INTEGRATION_MONDAY_DOWN',
  INTEGRATION_MONDAY_AUTH: 'INTEGRATION_MONDAY_AUTH',
  INTEGRATION_MONDAY_DRIFT: 'INTEGRATION_MONDAY_DRIFT',
  RATE_LIMIT_MONDAY_API: 'RATE_LIMIT_MONDAY_API',
  STARTUP_ERROR: 'STARTUP_ERROR',
  WEBHOOK_INVALID_SIGNATURE: 'WEBHOOK_INVALID_SIGNATURE',
  INTERNAL_DB_ERROR: 'INTERNAL_DB_ERROR',
} as const
export type BacklogErrorCode =
  (typeof BACKLOG_ERROR_CODES)[keyof typeof BACKLOG_ERROR_CODES]
