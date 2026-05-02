/**
 * github/pr-body-builder.ts — Builds the Markdown body for GitHub pull requests
 * opened by GitHubPROrchestrator.
 *
 * Per Round 5D spec §3.
 *
 * All inputs are plain data — no DB or HTTP calls here; the caller resolves the
 * required rows before constructing the builder.
 */

// ---------------------------------------------------------------------------
// Input types
// ---------------------------------------------------------------------------

export interface PRBodyStory {
  title: string
  description: string
}

export interface PRBodyAC {
  title: string
}

export interface PRBodySprint {
  number: number
  id: string
}

export interface PRBodyOptions {
  story: PRBodyStory
  acceptanceCriteria: PRBodyAC[]
  personaId: string
  personaDisplayName: string
  sprint: PRBodySprint
  capabilityId: string
  taskId: string
  /** Whether verifier evidence is available (false = pending). */
  verifierPassed?: boolean
  /** Optional freeform verifier evidence text. */
  verifierEvidence?: string
  /**
   * Round 7-08 — Operator-Attributed UI
   * Display name of the install that built this PR (e.g. "matt-laptop").
   * When present, included in the footer: "Built by [matt-laptop] · sr-dev · Sonnet"
   * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
   */
  installDisplayName?: string
  /** Model tier used (e.g. "Sonnet"). Optional; falls back to "Sonnet". */
  modelTier?: string
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/**
 * Build the PR description Markdown from task + story + AC + persona context.
 * Returns a string ready to be passed to `GitHubClient.createPullRequest`.
 */
export function buildPRBody(opts: PRBodyOptions): string {
  const { story, acceptanceCriteria, personaId, personaDisplayName, sprint, capabilityId, taskId } =
    opts

  const acLines =
    acceptanceCriteria.length > 0
      ? acceptanceCriteria.map((ac) => `- [ ] ${ac.title}`).join('\n')
      : '_No acceptance criteria defined._'

  const verifierSection =
    opts.verifierPassed === true && opts.verifierEvidence
      ? opts.verifierEvidence
      : 'Pending until verifier completes.'

  // Round 7-08 — Operator-Attributed UI: attribution footer
  // [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
  const installName = opts.installDisplayName ?? null
  const model = opts.modelTier ?? 'Sonnet'
  const attributionFooter = installName
    ? `Built by [${installName}] · ${personaId} · ${model}`
    : `Built by [orbital] · ${personaId} · ${model}`

  return `## Story
${story.title}

> ${story.description}

## Acceptance criteria
${acLines}

## Implementation
- **Persona-of-record:** ${personaId} (${personaDisplayName})
- **Sprint:** Sprint ${sprint.number} (${sprint.id})
- **Capability:** [Attestation chain](orbital://verify/${capabilityId})

## Verifier evidence
${verifierSection}

---
Opened by [Orbital](https://orbital.dev) on behalf of ${personaId} · Task ${taskId}
${attributionFooter}`
}
