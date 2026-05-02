/**
 * vision/types.ts — Domain types and Zod schemas for the vision intake module.
 *
 * Per TRD-01 §4.1, §4.2, §5.
 * All branded ID types come from @orbital/types.
 */

import { z } from 'zod'
import { ActorSchema } from '@orbital/types'

// ---------------------------------------------------------------------------
// Branded IDs (extending Primitives §3 — compile-time only)
// ---------------------------------------------------------------------------

type Brand<T, B> = T & { readonly __brand: B }

export type VisionDocumentId = Brand<string, 'VisionDocumentId'>
export type VisionVersionId = Brand<string, 'VisionVersionId'>
export type VisionSessionId = Brand<string, 'VisionSessionId'>
export type VisionMessageId = Brand<string, 'VisionMessageId'>
export type VisionQuestionId = Brand<string, 'VisionQuestionId'>
export type VisionAnswerId = Brand<string, 'VisionAnswerId'>
export type VisionAssumptionId = Brand<string, 'VisionAssumptionId'>

export const asVisionDocumentId = (s: string): VisionDocumentId => s as VisionDocumentId
export const asVisionSessionId = (s: string): VisionSessionId => s as VisionSessionId
export const asVisionVersionId = (s: string): VisionVersionId => s as VisionVersionId

// ---------------------------------------------------------------------------
// Vision document content schema (TRD-01 §4.2)
// ---------------------------------------------------------------------------

export const GoalSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(2000),
  rank: z.number().int().nonnegative(),
})

export const NonGoalSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(2000),
})

export const TargetUserSchema = z.object({
  id: z.string(),
  segment: z.string().min(1).max(200),
  description: z.string().min(1).max(2000),
  primary: z.boolean().default(false),
})

export const AcceptanceCriterionSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(2000),
  rank: z.number().int().nonnegative(),
})

export const GlossaryEntrySchema = z.object({
  term: z.string().min(1).max(120),
  definition: z.string().min(1).max(2000),
})

export const EdgeCaseSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(2000),
  surfaced_by: z.enum(['user', 'pm_persona']),
})

export const OpenQuestionSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(2000),
  raised_at: z.string().datetime(),
  raised_by: ActorSchema,
  blocking: z.boolean().default(true),
  resolved_at: z.string().datetime().optional(),
  resolution_summary: z.string().max(2000).optional(),
})

export const AssumptionSchema = z.object({
  id: z.string(),
  text: z.string().min(1).max(2000),
  appended_at: z.string().datetime(),
  appended_by: ActorSchema,
  confidence: z.enum(['low', 'medium', 'high']).default('medium'),
  evidence_link: z.string().url().optional(),
})

export const VisionDocumentContentSchema = z.object({
  schema_version: z.literal(1),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(4000),
  goals: z.array(GoalSchema).min(1),
  non_goals: z.array(NonGoalSchema).min(1),
  target_users: z.array(TargetUserSchema).min(1),
  acceptance_criteria: z.array(AcceptanceCriterionSchema).min(1),
  glossary: z.array(GlossaryEntrySchema),
  edge_cases: z.array(EdgeCaseSchema),
  open_questions: z.array(OpenQuestionSchema),
  assumptions_log: z.array(AssumptionSchema),
  metadata: z.object({
    pm_persona_id: z.string(),
    model_used: z.string(),
    intake_started_at: z.string().datetime(),
    intake_token_total: z.number().int().nonnegative(),
  }),
})

export type VisionDocumentContent = z.infer<typeof VisionDocumentContentSchema>

// Partial schema for draft documents — required fields may be absent or empty during intake.
// Goals/non_goals/etc. are optional; when provided they may be empty arrays.
export const VisionDocumentContentDraftSchema = z.object({
  schema_version: z.literal(1),
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(4000),
  goals: z.array(GoalSchema).optional().default([]),
  non_goals: z.array(NonGoalSchema).optional().default([]),
  target_users: z.array(TargetUserSchema).optional().default([]),
  acceptance_criteria: z.array(AcceptanceCriterionSchema).optional().default([]),
  glossary: z.array(GlossaryEntrySchema).optional().default([]),
  edge_cases: z.array(EdgeCaseSchema).optional().default([]),
  open_questions: z.array(OpenQuestionSchema).optional().default([]),
  assumptions_log: z.array(AssumptionSchema).optional().default([]),
  metadata: z.object({
    pm_persona_id: z.string(),
    model_used: z.string(),
    intake_started_at: z.string().datetime(),
    intake_token_total: z.number().int().nonnegative(),
  }),
})

export type VisionDocumentContentDraft = z.infer<typeof VisionDocumentContentDraftSchema>

// ---------------------------------------------------------------------------
// Event payload schemas (TRD-01 §5)
// ---------------------------------------------------------------------------

export const VisionSessionStartedPayloadSchemaV1 = z.object({
  vision_session_id: z.string(),
  vision_document_id: z.string(),
  initial_prompt: z.string().max(8000),
  pm_persona_request_id: z.string(),
  expected_required_capabilities: z.array(z.string()).default([]),
})

export const VisionMessageSentPayloadSchemaV1 = z.object({
  vision_session_id: z.string(),
  vision_message_id: z.string(),
  author_type: z.enum(['user', 'pm_persona']),
  body: z.string().max(32000),
  parent_message_id: z.string().optional(),
  body_tokens: z.number().int().nonnegative(),
})

export const VisionDraftedPayloadSchemaV1 = z.object({
  vision_session_id: z.string(),
  vision_document_id: z.string(),
  vision_version_id: z.string(),
  version_number: z.number().int().positive(),
  content_hash: z.string(),
  draft_summary: z.string().max(2000),
  open_questions_count: z.number().int().nonnegative(),
  is_locked: z.literal(false),
})

export const VisionAmbiguityRaisedPayloadSchemaV1 = z.object({
  vision_session_id: z.string(),
  vision_document_id: z.string(),
  vision_question_id: z.string(),
  prompt: z.string().max(2000),
  category: z.enum(['goal', 'non_goal', 'target_user', 'edge_case', 'glossary', 'ambiguity', 'other']),
  detected_signal: z.string().max(500),
  proposed_resolution: z.string().max(2000).optional(),
  blocking: z.boolean(),
})

export const VisionLockedPayloadSchemaV1 = z.object({
  vision_document_id: z.string(),
  vision_version_id: z.string(),
  version_number: z.number().int().positive(),
  content_hash: z.string(),
  locked_by: ActorSchema,
  monday_item_id: z.string().optional(),
  changelog: z.string().min(1).max(8000),
  attestation: z.object({
    no_edge_cases: z.boolean().default(false),
    confirmation_token: z.string(),
  }),
})

export const VisionRevisedPayloadSchemaV1 = z.object({
  vision_document_id: z.string(),
  prior_version_id: z.string(),
  prior_version_number: z.number().int().positive(),
  new_version_id: z.string(),
  new_version_number: z.number().int().positive(),
  delta: z.array(z.record(z.any())),
  changelog: z.string().min(1).max(8000),
  revised_by: ActorSchema,
  reason: z.enum(['user_initiated', 'architect_feedback', 'uat_defect', 'retro_proposal']),
})

export const VisionLockRejectedPayloadSchemaV1 = z.object({
  vision_document_id: z.string(),
  attempted_version_id: z.string(),
  rejecting_party: z.enum(['validator', 'hook_engine']),
  error_code: z.string(),
  missing_fields: z.array(z.string()).default([]),
  blocking_open_questions: z.array(z.string()).default([]),
  hook_id: z.string().optional(),
  hook_message: z.string().optional(),
})

// ---------------------------------------------------------------------------
// tRPC input / output types
// ---------------------------------------------------------------------------

export const AuditMetadataInputSchema = z.object({
  actor: ActorSchema,
  capability_id: z.string().optional(),
  justification: z.string().min(1),
  parent_event_id: z.string().optional(),
  trace_id: z.string(),
  linked_artifacts: z
    .array(z.object({ type: z.string(), id: z.string() }))
    .default([]),
})

export const SessionStartInputSchema = z.object({
  title: z.string().min(1).max(200),
  initial_prompt: z.string().min(1).max(8000),
  audit_metadata: AuditMetadataInputSchema,
})

export const SendMessageInputSchema = z.object({
  vision_session_id: z.string(),
  body: z.string().min(1).max(32000),
  parent_message_id: z.string().optional(),
  audit_metadata: AuditMetadataInputSchema,
})

export const LockInputSchema = z.object({
  vision_document_id: z.string(),
  confirmation_token: z.string(),
  changelog: z.string().min(1).max(8000),
  attestation: z.object({ no_edge_cases: z.boolean().default(false) }),
  audit_metadata: AuditMetadataInputSchema,
})

export const ReviseInputSchema = z.object({
  vision_document_id: z.string(),
  base_version_id: z.string(),
  delta: z.array(z.record(z.any())),
  changelog: z.string().min(1).max(8000),
  reason: z.enum(['user_initiated', 'architect_feedback', 'uat_defect', 'retro_proposal']),
  audit_metadata: AuditMetadataInputSchema,
})

export const GetInputSchema = z.object({
  vision_document_id: z.string(),
  // Version number can be:
  //   - undefined → return the current/latest version (locked or draft)
  //   - positive integer (1, 2, …) → a locked version
  //   - negative integer (-1, -2, …) → a PM-stub-authored draft snapshot.
  //     Drafts use negative numbers to avoid the unique-constraint collision
  //     with locked versions (1, 2, 3 …) per Phase 4A's storage convention.
  version_number: z.number().int().refine((n) => n !== 0, 'version_number cannot be 0').optional(),
})

export const HistoryInputSchema = z.object({
  vision_document_id: z.string(),
  after: z.string().optional(),
  limit: z.number().int().positive().max(100).default(20),
})
