/**
 * uat/types.ts — Shared types, Zod schemas, and error codes for the UAT workflow.
 *
 * Per TRD-11 v0.2 §5, §6, §9.
 *
 * All mutation schemas require a justification field (Primitives §14).
 * All payloads are validated by Zod and emitted via EventStore.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Re-export Drizzle row types
// ---------------------------------------------------------------------------

export type {
  UATSessionRow,
  UATSessionInsert,
  UATACResultRow,
  UATACResultInsert,
  DefectRow,
  DefectInsert,
  DefectLineageRow,
  DefectLineageInsert,
  PersonaOfRecordLinkRow,
  PersonaOfRecordLinkInsert,
  UATSessionState,
  UATACStatus,
  DefectSeverity,
  DefectState,
  PORRole,
  AssumptionItem,
} from '@orbital/db'

// ---------------------------------------------------------------------------
// tRPC input/output schemas (TRD-11 §6.1)
// ---------------------------------------------------------------------------

export const StartSessionInputSchema = z.object({
  ticket_id: z.string().uuid(),
  triggered_by_event_id: z.string().uuid(),
  build_ref: z.string().min(1),
  resume_existing: z.boolean().default(true),
  justification: z.string().min(1),
})
export type StartSessionInput = z.infer<typeof StartSessionInputSchema>

export const MarkACInputSchema = z
  .object({
    uat_session_id: z.string().uuid(),
    ac_id: z.string().uuid(),
    status: z.enum(['pass', 'fail']),
    observed_behavior: z.string().optional(),
    evidence_links: z
      .array(
        z.object({
          type: z.enum(['screenshot', 'log', 'video', 'audit_event', 'channel_post']),
          uri: z.string(),
          label: z.string().optional(),
        }),
      )
      .default([]),
    justification: z.string().min(1),
  })
  .refine(
    (v) => v.status === 'pass' || (v.observed_behavior && v.observed_behavior.length > 0),
    {
      message: 'observed_behavior is required when status is fail',
      path: ['observed_behavior'],
    },
  )
export type MarkACInput = z.infer<typeof MarkACInputSchema>

export const UnmarkACInputSchema = z.object({
  uat_session_id: z.string().uuid(),
  ac_id: z.string().uuid(),
  justification: z.string().min(1),
})
export type UnmarkACInput = z.infer<typeof UnmarkACInputSchema>

export const SubmitSessionInputSchema = z.object({
  uat_session_id: z.string().uuid(),
  outcome_notes: z.string().optional(),
  justification: z.string().min(1),
  confirm_unverified_assumptions: z.boolean().default(false),
})
export type SubmitSessionInput = z.infer<typeof SubmitSessionInputSchema>

export const AcceptSessionInputSchema = z.object({
  uat_session_id: z.string().uuid(),
  mode: z.enum(['full', 'partial']).optional().default('full'),
  justification: z.string().min(1),
})
export type AcceptSessionInput = z.infer<typeof AcceptSessionInputSchema>

export const ListDefectsInputSchema = z.object({
  state: z
    .enum(['open', 'triaged', 'assigned', 'in_progress', 'resolved', 'verified', 'reopened', 'closed'])
    .optional(),
  severity: z.enum(['critical', 'high', 'medium', 'low']).optional(),
  origin_story_id: z.string().uuid().optional(),
  persona_of_record_id: z.string().optional(),
  created_after: z.string().datetime().optional(),
  limit: z.number().int().positive().default(50),
  after: z.string().optional(),
})
export type ListDefectsInput = z.infer<typeof ListDefectsInputSchema>

export const GetSessionInputSchema = z.object({
  uat_session_id: z.string().uuid(),
})
export type GetSessionInput = z.infer<typeof GetSessionInputSchema>

export const ListSessionsInputSchema = z.object({
  ticket_id: z.string().uuid(),
  include_ac_results: z.boolean().default(true),
})
export type ListSessionsInput = z.infer<typeof ListSessionsInputSchema>

// ---------------------------------------------------------------------------
// Mark/unmark output
// ---------------------------------------------------------------------------

export interface MarkACOutput {
  ac_result_id: string
  status: 'pass' | 'fail' | 'pending'
  pass_count: number
  fail_count: number
  pending_count: number
}

// ---------------------------------------------------------------------------
// Submit output
// ---------------------------------------------------------------------------

export interface SubmitOutput {
  uat_session_id: string
  outcome: 'accepted' | 'partially_accepted' | 'rejected'
  pass_count: number
  fail_count: number
  defects_created: Array<{
    defect_id: string
    defect_key: string
    origin_ac_id: string
    severity: 'critical' | 'high' | 'medium' | 'low'
    preempts_sprint: boolean
  }>
}

// ---------------------------------------------------------------------------
// Error codes (TRD-11 §9) — UAT_* domain prefix
// ---------------------------------------------------------------------------

export const UAT_ERROR_CODES = {
  NOT_FOUND_UAT_SESSION: 'NOT_FOUND_UAT_SESSION',
  NOT_FOUND_TICKET: 'NOT_FOUND_TICKET',
  NOT_FOUND_AC: 'NOT_FOUND_AC',
  NOT_FOUND_DEFECT: 'NOT_FOUND_DEFECT',
  CONFLICT_INVALID_STATE_TRANSITION: 'CONFLICT_INVALID_STATE_TRANSITION',
  CONFLICT_STORY_NOT_DONE: 'CONFLICT_STORY_NOT_DONE',
  VALIDATION_REQUIRED_FIELD_MISSING: 'VALIDATION_REQUIRED_FIELD_MISSING',
  VALIDATION_PENDING_ACS_REMAIN: 'VALIDATION_PENDING_ACS_REMAIN',
  VERIFIER_AC_FAILED: 'VERIFIER_AC_FAILED',
  UAT_DEFECT_CREATION_FAILED: 'UAT_DEFECT_CREATION_FAILED',
  UAT_AC_NOT_MARKED: 'UAT_AC_NOT_MARKED',
  UAT_PERSONA_OF_RECORD_UNRESOLVABLE: 'UAT_PERSONA_OF_RECORD_UNRESOLVABLE',
  AUTH_SCOPE_DENIED: 'AUTH_SCOPE_DENIED',
  INTERNAL_DB_ERROR: 'INTERNAL_DB_ERROR',
} as const
export type UATErrorCode = (typeof UAT_ERROR_CODES)[keyof typeof UAT_ERROR_CODES]

// ---------------------------------------------------------------------------
// Severity rule engine types (TRD-11 §8.3)
// ---------------------------------------------------------------------------

export interface SeverityRuleContext {
  acText: string
  storyId: string
  sessionId: string
  failedAcCountForStory: number
  totalAcCountForStory: number
  isReopen: boolean
  acTags?: string[]
  observedValue?: number
  expectedValue?: number
}

export type DefectSeverityResult = 'critical' | 'high' | 'medium' | 'low'

// ---------------------------------------------------------------------------
// Defect creation params
// ---------------------------------------------------------------------------

export interface CreateDefectParams {
  failedAcResultId: string
  sessionId: string
  storyId: string
  acId: string
  acText: string
  observedBehavior: string
  personaOfRecordId: string
  severity: DefectSeverityResult
  preemptsSprint: boolean
  sprintId?: string
}
