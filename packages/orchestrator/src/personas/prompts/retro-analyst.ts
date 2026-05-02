/**
 * Retro analyst persona system prompt.
 *
 * Used by RetroService.analyze() in real-LLM mode. The retro analyst's job is
 * to look at one sprint's audit data — cost rows, hook fires, defects,
 * verifier outcomes, escalations — and propose 1-3 concrete changes to the
 * agent organisation that would improve metrics next sprint.
 *
 * Each proposal is written into one "layer": persona, skill, hook, ceremony,
 * routing, orchestrator, environment, or board. Exactly one of these is the
 * dominant layer.
 *
 * The model returns an array of proposals (≤3). Each proposal is validated
 * against retros/types.ProposalSchema before persistence.
 */

import { z } from 'zod'
import { PROPOSAL_LAYER, PROPOSAL_CHANGE_TYPE, EXPECTED_DIRECTION } from '../../db/schema/retros.js'

// ---------------------------------------------------------------------------
// Response schema (the LLM-friendly shape — gets translated into Proposal)
// ---------------------------------------------------------------------------

const LayerEntrySchema = z.object({
  layer: z.enum(PROPOSAL_LAYER),
  target_path: z.string().min(1),
  change_type: z.enum(PROPOSAL_CHANGE_TYPE),
  is_dominant: z.boolean(),
  diff_preview: z.string().optional(),
})

export const RetroAnalystProposalSchema = z.object({
  proposal_code: z.string().min(1).max(64),
  title: z.string().min(1).max(200),
  hypothesis: z.string().min(20).max(2000),
  expected_impact: z.object({
    metric_key: z.string().min(1),
    direction: z.enum(EXPECTED_DIRECTION),
    pct_points: z.number().int(),
  }),
  rollback_path: z.string().min(10),
  layers: z.array(LayerEntrySchema).min(1).max(10),
  confidence_score: z.number().int().min(0).max(100),
  current_value: z.string().optional(),
  proposed_value: z.string().optional(),
})
export type RetroAnalystProposal = z.infer<typeof RetroAnalystProposalSchema>

export const RetroAnalystResponseSchema = z.object({
  proposals: z.array(RetroAnalystProposalSchema).min(0).max(3),
  reasoning_summary: z.string().min(1).max(2000),
})
export type RetroAnalystResponse = z.infer<typeof RetroAnalystResponseSchema>

// ---------------------------------------------------------------------------
// Sprint context shape
// ---------------------------------------------------------------------------

export interface RetroSprintContext {
  sprintId: string
  startedAt: string | null
  completedAt: string | null
  /** Aggregate cost in micros across the sprint. */
  totalCostUsdMicros: number
  /** Number of tasks that completed. */
  completedTaskCount: number
  /** Number of tasks that failed. */
  failedTaskCount: number
  /** Number of CapabilityDenied events. */
  capabilityDenialCount: number
  /** Number of BlockerEscalated events. */
  escalationCount: number
  /** Number of defects raised against UAT. */
  defectCount: number
  /** Verifier pass-rate (0..100). */
  verifierPassRatePct: number
  /** P50 cycle time in ms (null if not enough data). */
  cycleTimeP50Ms: number | null
  /** P90 cycle time in ms. */
  cycleTimeP90Ms: number | null
  /** Free-form raw metric blob already computed by RetroService. */
  rawMetrics: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const STATIC_SYSTEM = `# Role: Retro Analyst

You analyse one sprint's audit-log data and propose concrete changes to the
agent organisation that would improve metrics next sprint. You do not apply
changes; you propose them. A separate ProposalService routes proposals through
human approval before they take effect.

## Your output

Up to 3 proposals per sprint. Each proposal must:

1. Have a unique \`proposal_code\` like 'PRP-S{sprint}-001'.
2. Cite ONE dominant layer from this list:
   - \`persona\` — change a persona definition
   - \`skill\` — add or modify a skill
   - \`hook\` — add or modify a pre/post hook
   - \`ceremony\` — change a ceremony spec
   - \`routing\` — change the routing policy
   - \`orchestrator\` — change orchestrator config
   - \`environment\` — change devcontainer/CI/linters
   - \`board\` — change board schema/automations
3. Include \`target_path\` matching the canonical glob for that layer:
   - \`personas/{slug}.md\` or \`personas/{slug}.ts\`
   - \`skills/{any}.{md,ts}\`
   - \`hooks/{pre,post}-{commit,merge,task,sprint,status-transition}/{name}.ts\` or \`hooks/baseline/{name}.ts\`
   - \`ceremonies/{any}.{md,ts,yaml,yml}\`
   - \`routing/{any}.{yaml,yml,ts,json}\` or \`routing-policy.{ts,yaml,json}\`
   - \`orchestrator/config/{any}.{yaml,yml,ts,json}\` or \`orchestrator/policy/{any}.{...}\`
   - \`environment/(devcontainer|ci|linters)/{any}\`
   - \`board/(schema|automations)/{any}.{yaml,yml}\`
4. Specify exactly ONE \`is_dominant: true\` layer; secondary layers may be
   listed with \`is_dominant: false\`.
5. State a measurable hypothesis tied to a real metric: cost_usd_micros,
   cycle_time_p50_ms, cycle_time_p90_ms, capability_denial_count,
   escalation_count, defect_count, verifier_pass_rate_pct.
6. State an explicit \`rollback_path\` — how to revert if the change is bad.
7. Score your confidence 0-100. Lower means "spitballing"; higher means
   "strong signal in the data".

## What "good" looks like

- "Verifier pass rate is 73% sprint-on-sprint. Failures concentrate on tasks
  routed to Haiku for risk_class=high. Proposal: pin risk_class=high to
  Sonnet in routing-policy.yaml."
- "Capability denials spiked 4x for sr-dev tasks involving \`secrets\`.
  Proposal: extend sr-dev's defaultCapabilityProfile to include the SDK key
  in personas/sr-dev.ts."

## What "bad" looks like (do not produce these)

- Vague: "Improve retro processes."
- Multi-layer dominant: marking two layers as dominant.
- Out-of-scope: changes outside the listed layers (e.g. application code).

If the sprint data does not support a confident proposal, return an empty
array. It is better to ship zero proposals than a low-quality one.

Respond now via the respond_with_json tool.`

export function buildRetroAnalystSystemPrompt(): string {
  return STATIC_SYSTEM
}

export function buildRetroAnalystUserPrompt(ctx: RetroSprintContext): string {
  const lines: string[] = []
  lines.push(`# Sprint ${ctx.sprintId}`)
  lines.push('')
  lines.push(`- Started: ${ctx.startedAt ?? 'unknown'}`)
  lines.push(`- Completed: ${ctx.completedAt ?? 'unknown'}`)
  lines.push('')
  lines.push('## Aggregate metrics')
  lines.push(`- Total cost (USD micros): ${ctx.totalCostUsdMicros}`)
  lines.push(`- Tasks completed: ${ctx.completedTaskCount}`)
  lines.push(`- Tasks failed: ${ctx.failedTaskCount}`)
  lines.push(`- Capability denials: ${ctx.capabilityDenialCount}`)
  lines.push(`- Blocker escalations: ${ctx.escalationCount}`)
  lines.push(`- Defects raised: ${ctx.defectCount}`)
  lines.push(`- Verifier pass rate: ${ctx.verifierPassRatePct}%`)
  lines.push(`- Cycle time p50: ${ctx.cycleTimeP50Ms ?? 'n/a'} ms`)
  lines.push(`- Cycle time p90: ${ctx.cycleTimeP90Ms ?? 'n/a'} ms`)
  lines.push('')
  lines.push('## Raw metric blob')
  lines.push('```json')
  lines.push(JSON.stringify(ctx.rawMetrics, null, 2))
  lines.push('```')
  lines.push('')
  lines.push('Produce at most 3 proposals. Use proposal codes like ' +
    `\`PRP-S${ctx.sprintId.slice(0, 8)}-001\`. Return an empty proposals array ` +
    'if the data does not support a confident change.')
  return lines.join('\n')
}
