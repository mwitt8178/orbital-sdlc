/**
 * retros/types.ts - Zod schemas and TypeScript types for the Retro service.
 *
 * Per TRD-10 v0.1 §4 (data model) and §5 (events).
 *
 * The runtime Zod shapes in this file are used both by RetroService for
 * validating proposal output before persistence (TRD-10 §8.1 step 5) and by
 * the tRPC router for inputs/outputs.
 */

import { z } from 'zod'
import {
  PROPOSAL_LAYER,
  PROPOSAL_STATUS,
  PROPOSAL_CHANGE_TYPE,
  RETRO_REPORT_STATUS,
  EXPECTED_DIRECTION,
  type ProposalLayer,
  type ProposalStatus,
  type ProposalChangeType,
  type RetroReportStatus,
  type ExpectedDirection,
} from '../db/schema/retros.js'

// Re-export the layer enum so callers don't need to import from schema/.
export { PROPOSAL_LAYER, PROPOSAL_STATUS, PROPOSAL_CHANGE_TYPE, EXPECTED_DIRECTION }
export type { ProposalLayer, ProposalStatus, ProposalChangeType, RetroReportStatus, ExpectedDirection }

// ---------------------------------------------------------------------------
// ProposalLayerSchema
// ---------------------------------------------------------------------------

export const ProposalLayerSchema = z.enum(PROPOSAL_LAYER)

// ---------------------------------------------------------------------------
// Layer canonical paths (TRD-10 §8.3)
// ---------------------------------------------------------------------------

/**
 * Canonical path globs by layer. Used by the proposal validator to reject
 * proposals whose target_path does not match the declared layer's glob.
 *
 * Per TRD-10 §8.3.
 */
export const LAYER_PATH_GLOBS: Record<ProposalLayer, RegExp[]> = {
  persona: [/^personas\/[^/]+\.md$/, /^personas\/[^/]+\.ts$/],
  skill: [/^skills\/.+\.(md|ts)$/],
  hook: [/^hooks\/(pre|post)-(commit|merge|task|sprint|status-transition)\/[^/]+\.ts$/, /^hooks\/baseline\/[^/]+\.ts$/],
  ceremony: [/^ceremonies\/.+\.(md|ts|yaml|yml)$/],
  routing: [/^routing\/.+\.(yaml|yml|ts|json)$/, /^routing-policy\.(ts|yaml|json)$/],
  orchestrator: [/^orchestrator\/(config|policy)\/.+\.(yaml|yml|ts|json)$/],
  environment: [/^environment\/(devcontainer|ci|linters)\/.+/],
  board: [/^board\/(schema|automations)\/.+\.(yaml|yml)$/],
}

// ---------------------------------------------------------------------------
// Proposal evidence reference
// ---------------------------------------------------------------------------

export const EvidenceRefSchema = z.object({
  event_id: z.string(),
  aggregate_id: z.string().optional(),
  summary: z.string().min(1),
})
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>

// ---------------------------------------------------------------------------
// Proposal layer entry (one row per layer touched per proposal)
// ---------------------------------------------------------------------------

export const ProposalLayerEntrySchema = z.object({
  layer: ProposalLayerSchema,
  target_path: z.string().min(1),
  change_type: z.enum(PROPOSAL_CHANGE_TYPE),
  is_dominant: z.boolean(),
  /** Free-form unified diff preview (truncated for UI). */
  diff_preview: z.string().optional(),
})
export type ProposalLayerEntry = z.infer<typeof ProposalLayerEntrySchema>

// ---------------------------------------------------------------------------
// Proposal Zod (used both for service-side validation and tRPC inputs)
// ---------------------------------------------------------------------------

export const ProposalSchema = z.object({
  /** Per TRD-10 §6.4: humans see a code like 'PRP-S13-001'. */
  proposal_code: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  hypothesis: z.string().min(20).max(2000),
  expected_impact: z.object({
    metric_key: z.string().min(1),
    direction: z.enum(EXPECTED_DIRECTION),
    /** Signed integer; -1000 means "down 10%". */
    pct_points: z.number().int(),
    confidence_interval: z
      .object({ low: z.number().int(), high: z.number().int() })
      .optional(),
  }),
  rollback_path: z.string().min(10),
  layers: z.array(ProposalLayerEntrySchema).min(1).max(10),
  evidence_refs: z.array(EvidenceRefSchema).max(50).default([]),
  /** Confidence 0..100. */
  confidence_score: z.number().int().min(0).max(100).default(50),
  /** Sprint scope: which sprint this proposal applies to (else global). */
  applies_to_sprint_id: z.string().uuid().optional(),
  is_global: z.boolean().default(false),
  /** Snapshot of the current value of the target. */
  current_value: z.unknown().optional(),
  /** What the proposal recommends the value become. */
  proposed_value: z.unknown().optional(),
  /** Free-text proposed file content (used by ProposalService.approve to commit). */
  proposed_file_content: z.string().optional(),
})
export type Proposal = z.infer<typeof ProposalSchema>

// ---------------------------------------------------------------------------
// Validate exactly-one-dominant rule (TRD-10 §8.3)
// ---------------------------------------------------------------------------

export function assertExactlyOneDominant(layers: ProposalLayerEntry[]): void {
  const dominantCount = layers.filter((l) => l.is_dominant).length
  if (dominantCount !== 1) {
    throw new Error(
      `VALIDATION_PROPOSAL_MISSING_DOMINANT_LAYER: expected exactly one dominant layer, got ${dominantCount}`,
    )
  }
}

// ---------------------------------------------------------------------------
// Validate layer path globs (TRD-10 §8.3)
// ---------------------------------------------------------------------------

export function assertLayerPathMatch(layer: ProposalLayer, targetPath: string): void {
  const patterns = LAYER_PATH_GLOBS[layer]
  for (const re of patterns) {
    if (re.test(targetPath)) return
  }
  throw new Error(
    `VALIDATION_LAYER_PATH_MISMATCH: target_path '${targetPath}' does not match the canonical glob for layer '${layer}'`,
  )
}

// ---------------------------------------------------------------------------
// RetroReport — read shape (used by tRPC and tests)
// ---------------------------------------------------------------------------

export const RetroReportSchema = z.object({
  retro_report_id: z.string().uuid(),
  sprint_id: z.string().uuid(),
  system_version_id: z.string().uuid().nullable(),
  analysis_run_seq: z.number().int().positive(),
  status: z.enum(RETRO_REPORT_STATUS),
  started_at: z.string().datetime(),
  completed_at: z.string().datetime().nullable(),
  proposal_count: z.number().int().nonnegative(),
  approved_count: z.number().int().nonnegative(),
  rejected_count: z.number().int().nonnegative(),
  deferred_count: z.number().int().nonnegative(),
  retro_on_retro_accuracy: z.number().int().nullable(),
  failure_reason: z.string().nullable(),
})
export type RetroReport = z.infer<typeof RetroReportSchema>

// ---------------------------------------------------------------------------
// SystemVersion — read shape
// ---------------------------------------------------------------------------

export const SystemVersionSchema = z.object({
  system_version_id: z.string().uuid(),
  version_number: z.string(),
  parent_system_version_id: z.string().uuid().nullable(),
  git_tag: z.string(),
  git_sha: z.string(),
  shipped_at: z.string().datetime(),
  shipped_by: z.string(),
  is_rollback: z.boolean(),
  rolled_back_version_id: z.string().uuid().nullable(),
  retro_report_id: z.string().uuid().nullable(),
  notes: z.string().nullable(),
})
export type SystemVersion = z.infer<typeof SystemVersionSchema>

// ---------------------------------------------------------------------------
// RetroOutcome — read shape
// ---------------------------------------------------------------------------

export const RetroOutcomeSchema = z.object({
  retro_outcome_id: z.string().uuid(),
  retro_proposal_id: z.string().uuid(),
  system_version_id: z.string().uuid(),
  metric_key: z.string(),
  expected_direction: z.enum(EXPECTED_DIRECTION),
  expected_pct_points: z.number().int(),
  window_sprint_count: z.number().int().positive(),
  window_start_sprint_id: z.string().uuid().nullable(),
  window_end_sprint_id: z.string().uuid().nullable(),
  baseline_value: z.unknown().nullable(),
  actual_pct_points: z.number().int().nullable(),
  tolerance_band: z.number().int().positive(),
  matched_expectation: z.boolean().nullable(),
  computed_at: z.string().datetime().nullable(),
})
export type RetroOutcome = z.infer<typeof RetroOutcomeSchema>

// ---------------------------------------------------------------------------
// Event payload schemas (TRD-10 §5.3 - §5.6)
// ---------------------------------------------------------------------------

export const RetroAnalysisStartedPayloadV1 = z.object({
  retro_report_id: z.string(),
  sprint_id: z.string(),
  system_version_id: z.string().nullable(),
  analysis_run_seq: z.number().int().positive(),
  triggered_by: z.enum(['sprint_completed', 'manual_rerun']),
  schema_version: z.literal(1),
})

export const RetroReportGeneratedPayloadV1 = z.object({
  retro_report_id: z.string(),
  sprint_id: z.string(),
  proposal_count: z.number().int().nonnegative(),
  proposal_layer_distribution: z.record(ProposalLayerSchema, z.number().int().nonnegative()),
  duration_ms: z.number().int().nonnegative(),
  schema_version: z.literal(1),
})

export const RetroProposedPayloadV1 = z.object({
  retro_proposal_id: z.string(),
  retro_report_id: z.string(),
  proposal_code: z.string(),
  title: z.string(),
  hypothesis: z.string().min(20).max(2000),
  expected_impact: z.object({
    metric_key: z.string(),
    direction: z.enum(EXPECTED_DIRECTION),
    pct_points: z.number().int(),
    confidence_interval: z
      .object({ low: z.number().int(), high: z.number().int() })
      .optional(),
  }),
  rollback_path: z.string().min(10),
  layers: z.array(ProposalLayerEntrySchema).min(1),
  evidence_refs: z.array(EvidenceRefSchema).max(50),
  confidence_score: z.number().int().min(0).max(100),
  schema_version: z.literal(1),
})

const DecisionBaseV1 = z.object({
  retro_proposal_id: z.string(),
  decided_by_user_id: z.string(),
  decision_rationale: z.string().min(1),
  schema_version: z.literal(1),
})

export const RetroApprovedPayloadV1 = DecisionBaseV1.extend({
  pr_ref: z.string(),
  merged_system_version_id: z.string(),
  shipped_git_sha: z.string(),
})

export const RetroRejectedPayloadV1 = DecisionBaseV1

export const RetroDeferredPayloadV1 = DecisionBaseV1.extend({
  defer_until_retro_after_sprint_id: z.string().optional(),
})

export const RetroRolledBackPayloadV1 = z.object({
  rolled_back_proposal_id: z.string().nullable(),
  rolled_back_system_version_id: z.string(),
  new_system_version_id: z.string(),
  user_id: z.string(),
  rationale: z.string().min(1),
  impact_preview: z.object({
    affected_files: z.array(z.string()),
    dependent_proposal_ids: z.array(z.string()),
  }),
  schema_version: z.literal(1),
})

export const SystemVersionShippedPayloadV1 = z.object({
  system_version_id: z.string(),
  version_number: z.string(),
  parent_system_version_id: z.string().nullable(),
  git_tag: z.string(),
  git_sha: z.string(),
  retro_report_id: z.string().nullable(),
  proposal_ids_merged: z.array(z.string()),
  is_rollback: z.boolean(),
  rolled_back_version_id: z.string().nullable(),
  schema_version: z.literal(1),
})

export const OutcomeRecordedPayloadV1 = z.object({
  retro_outcome_id: z.string(),
  retro_proposal_id: z.string(),
  system_version_id: z.string(),
  metric_key: z.string(),
  expected_pct_points: z.number().int(),
  actual_pct_points: z.number().int(),
  matched_expectation: z.boolean(),
  tolerance_band: z.number().int(),
  window_sprint_ids: z.array(z.string()),
  schema_version: z.literal(1),
})

// ---------------------------------------------------------------------------
// Commit info (returned by AgentOrgRepo.log())
// ---------------------------------------------------------------------------

export interface CommitInfo {
  hash: string
  shortHash: string
  message: string
  author: string
  date: string
}
