/**
 * Persona-of-record reasoning prompt.
 *
 * Used by `uat/persona-of-record.ts` when the four-step attestation chain
 * walks all the way to the tasks.persona_id fallback. Before settling on the
 * task's assigned persona, we do one cheap LLM call to ask: "given this
 * defect description and the recent commit log for these files, who is the
 * most likely persona-of-record?"
 *
 * The model sees the candidate personas (typically: pm, sr-dev, jr-dev,
 * principal-dev, qa, architect, security) along with a short blurb about
 * each, plus the defect description and file paths. It returns a persona_id
 * with a confidence score 0-100. When confidence < 60 we discard the
 * suggestion and fall back to tasks.persona_id; when ≥ 60 we use it.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Response schema
// ---------------------------------------------------------------------------

export const PersonaOfRecordResponseSchema = z.object({
  persona_id: z.string().min(1).max(64),
  confidence_score: z.number().int().min(0).max(100),
  rationale: z.string().min(1).max(1000),
})
export type PersonaOfRecordResponse = z.infer<typeof PersonaOfRecordResponseSchema>

// ---------------------------------------------------------------------------
// Context shape
// ---------------------------------------------------------------------------

export interface PersonaOfRecordContext {
  /** AC id we're trying to attribute. */
  acId: string
  /** Story id. */
  storyId: string
  /** Defect description (free text from the UAT submitter). */
  defectDescription: string
  /** Files associated with the defect (from worktree or task metadata). */
  filePaths: string[]
  /** Recent commits touching these files, oldest first. */
  recentCommits: Array<{
    sha: string
    message: string
    author: string
    files: string[]
  }>
  /** Candidate persona slugs available in the install. */
  candidatePersonaSlugs: string[]
  /** The tasks.persona_id fallback — what we'd use if this LLM call fails. */
  tasksFallbackPersonaId: string
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

const STATIC_SYSTEM = `# Role: Persona-of-Record Resolver

You attribute a defect to the persona most likely responsible for the code
change that caused it. You are the LAST step before the system falls back to
the task's assigned persona.

## How to decide

1. Read the defect description.
2. Examine the file paths and recent commit messages.
3. Match the work to a persona:
   - sr-dev / jr-dev / principal-dev — application code, bug fixes, refactors
   - architect — system design, infra changes, schema migrations
   - pm — spec changes, AC files, vision documents
   - qa — test files, verification logic
   - security — IAM, capability scopes, key management
   - em — orchestration config, scheduler tweaks
   - scrum-master — ceremony specs, sprint config
4. Return a persona_id from the candidate list ONLY. Do not invent slugs.
5. Score your confidence 0-100:
   - 80-100: commit messages and file paths clearly point to this persona
   - 60-79: file paths suggest this persona; commit messages are
     consistent
   - 0-59: insufficient signal — this means "fall back to tasks.persona_id"

When in doubt, return the tasks.persona_id fallback with a low confidence
score so the system uses it as-is.

Respond now via the respond_with_json tool.`

export function buildPersonaOfRecordSystemPrompt(): string {
  return STATIC_SYSTEM
}

export function buildPersonaOfRecordUserPrompt(ctx: PersonaOfRecordContext): string {
  const lines: string[] = []
  lines.push(`## Defect`)
  lines.push(`Story: ${ctx.storyId}`)
  lines.push(`AC: ${ctx.acId}`)
  lines.push(`Description: ${ctx.defectDescription}`)
  lines.push('')
  lines.push('## Affected files')
  if (ctx.filePaths.length === 0) {
    lines.push('(none provided)')
  } else {
    for (const f of ctx.filePaths) lines.push(`- ${f}`)
  }
  lines.push('')
  lines.push('## Recent commits touching these files')
  if (ctx.recentCommits.length === 0) {
    lines.push('(no commit log available)')
  } else {
    for (const c of ctx.recentCommits) {
      lines.push(`- ${c.sha.slice(0, 8)} by ${c.author}: ${c.message}`)
    }
  }
  lines.push('')
  lines.push('## Candidate persona slugs')
  for (const slug of ctx.candidatePersonaSlugs) lines.push(`- ${slug}`)
  lines.push('')
  lines.push(`## Fallback if you have insufficient signal`)
  lines.push(
    `tasks.persona_id resolves to "${ctx.tasksFallbackPersonaId}". Return that ` +
      'with confidence_score < 60 to indicate "use the fallback".',
  )
  lines.push('')
  lines.push('Reason now and return your best persona_id.')
  return lines.join('\n')
}
