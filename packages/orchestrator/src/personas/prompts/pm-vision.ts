/**
 * PM persona system prompt — vision intake.
 *
 * Used by VisionPMStub.onMessage() in real-LLM mode. The PM's job during
 * intake is to:
 *
 *   1. Read the latest draft (or the empty starting state).
 *   2. Read the conversation history with the user.
 *   3. Decide:
 *        a. ask one focused follow-up question, OR
 *        b. propose a revision to the draft (goals/target_users/summary), OR
 *        c. signal lock_ready=true.
 *
 * The model's response is forced through a `respond_with_json` tool whose
 * input_schema is the Zod schema in `pm-vision-response.ts`.
 *
 * Style guidance is intentionally lifted from `personas/library/pm.ts` so the
 * real LLM behaves the same as the static persona definition promises.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Response schema — what the PM must return
// ---------------------------------------------------------------------------

export const PMVisionDraftUpdateSchema = z.object({
  /** Optional new title; only set when the user has changed it. */
  title: z.string().min(1).max(200).optional(),
  /** Top-line summary; will replace prior summary verbatim. */
  summary: z.string().min(1).max(4000).optional(),
  /**
   * Goals to set. When this field is provided, it REPLACES prior goals
   * wholesale. Omit to leave prior goals unchanged.
   */
  goals: z.array(z.string().min(1).max(2000)).optional(),
  /** Same semantics as goals: omit to leave unchanged, provide to replace. */
  non_goals: z.array(z.string().min(1).max(2000)).optional(),
  /** Same semantics as goals. */
  target_users: z
    .array(
      z.object({
        segment: z.string().min(1).max(200),
        description: z.string().min(1).max(2000),
        primary: z.boolean(),
      }),
    )
    .optional(),
  /** Same semantics as goals. */
  acceptance_criteria: z.array(z.string().min(1).max(2000)).optional(),
})
export type PMVisionDraftUpdate = z.infer<typeof PMVisionDraftUpdateSchema>

export const PMVisionResponseSchema = z.object({
  /**
   * The PM's reply to the user. Always set — even when also returning a
   * draft_update or lock_ready. This is the message the user will see in the
   * chat panel.
   */
  reply: z.string().min(1).max(4000),
  /**
   * One focused follow-up question. Set when the PM still needs information
   * to lock the vision. Optional — when the PM is mostly proposing updates,
   * `reply` carries the next prompt and this can be omitted.
   */
  next_question: z.string().min(1).max(1000).nullable().optional(),
  /** Optional draft updates the user can accept or override. */
  draft_update: PMVisionDraftUpdateSchema.optional(),
  /**
   * True when the PM thinks the draft is complete enough that the user can
   * lock it. The UI surfaces a "Lock vision" affordance when this is set.
   */
  lock_ready: z.boolean().default(false),
})
export type PMVisionResponse = z.infer<typeof PMVisionResponseSchema>

// ---------------------------------------------------------------------------
// Conversation context shape
// ---------------------------------------------------------------------------

export interface PMVisionContext {
  /** Conversation history — oldest first. */
  history: Array<{ author: 'user' | 'pm_persona'; body: string }>
  /** The current draft (if any). */
  draft?: {
    title: string
    summary?: string
    goals?: string[]
    non_goals?: string[]
    target_users?: Array<{ segment: string; description: string; primary: boolean }>
    acceptance_criteria?: string[]
  }
  /** Total user-message count so the PM knows how far in we are. */
  userMessageCount: number
}

// ---------------------------------------------------------------------------
// System prompt builder
// ---------------------------------------------------------------------------

const STATIC_SYSTEM = `# Role: Product Manager — Vision Intake

You are the Product Manager. You own clarity. Your job during intake is to ask
focused questions and synthesize a draft vision document with the user. You do
not implement, architect, or estimate; you produce specs.

## Your behaviour rules

- Ask exactly ONE follow-up question per turn. Never stack multiple questions.
  If you need three things, ask the most important one first.
- Reject hedge words. "Loads quickly" is not acceptable; "loads in under 2.0s
  on a 4G connection" is acceptable. When the user is vague, ask for the
  measurable form.
- Acceptance criteria are written as Given/When/Then with exact thresholds.
- If a statement admits multiple interpretations, propose two or three
  concrete clarifications and ask which the user intended. Do not paper over
  ambiguity.
- After 3-5 productive exchanges, the draft should be substantial enough to
  lock. When it is, set lock_ready=true and tell the user.

## What you produce on each turn

You ALWAYS reply (the user sees a chat message). You MAY also propose
\`draft_update\`s. You MAY signal \`lock_ready=true\` when the document is
substantive (clear summary, at least one goal, identified target users, at
least one acceptance criterion).

## How to update the draft

- \`draft_update.summary\` REPLACES the prior summary in full.
- \`draft_update.goals\` REPLACES the prior goals array.
- Same for \`non_goals\`, \`target_users\`, \`acceptance_criteria\`.
- Only include fields you intend to change. Leaving a field undefined keeps
  the prior value.

## Tone

Direct, plain English. No marketing language. Cite the user's words back when
you propose updates so they can see the connection.`

export function buildPMVisionSystemPrompt(): string {
  return STATIC_SYSTEM
}

/**
 * Build the user prompt. The system prompt is static (cached); the per-turn
 * user prompt carries the dynamic context.
 */
export function buildPMVisionUserPrompt(ctx: PMVisionContext): string {
  const lines: string[] = []

  lines.push(`Current user message count: ${ctx.userMessageCount}`)
  lines.push('')

  if (ctx.draft) {
    lines.push('## Current draft')
    lines.push(`Title: ${ctx.draft.title}`)
    if (ctx.draft.summary) lines.push(`Summary: ${ctx.draft.summary}`)
    if (ctx.draft.goals && ctx.draft.goals.length > 0) {
      lines.push('Goals:')
      for (const g of ctx.draft.goals) lines.push(`  - ${g}`)
    }
    if (ctx.draft.non_goals && ctx.draft.non_goals.length > 0) {
      lines.push('Non-goals:')
      for (const g of ctx.draft.non_goals) lines.push(`  - ${g}`)
    }
    if (ctx.draft.target_users && ctx.draft.target_users.length > 0) {
      lines.push('Target users:')
      for (const u of ctx.draft.target_users) {
        const tag = u.primary ? '[primary]' : '[secondary]'
        lines.push(`  - ${tag} ${u.segment} — ${u.description}`)
      }
    }
    if (ctx.draft.acceptance_criteria && ctx.draft.acceptance_criteria.length > 0) {
      lines.push('Acceptance criteria:')
      for (const ac of ctx.draft.acceptance_criteria) lines.push(`  - ${ac}`)
    }
  } else {
    lines.push('## Current draft')
    lines.push('(empty — this is the start of intake)')
  }

  lines.push('')
  lines.push('## Conversation so far')
  if (ctx.history.length === 0) {
    lines.push('(no prior turns)')
  } else {
    for (const msg of ctx.history) {
      const tag = msg.author === 'user' ? 'User' : 'PM'
      lines.push(`${tag}: ${msg.body}`)
    }
  }

  lines.push('')
  lines.push(
    'Respond now via the respond_with_json tool. Use `reply` for the chat ' +
      "message, `draft_update` to propose changes, and `lock_ready=true` only " +
      'when the draft is substantive.',
  )

  return lines.join('\n')
}
