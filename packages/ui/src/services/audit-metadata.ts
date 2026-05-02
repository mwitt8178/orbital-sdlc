/**
 * services/audit-metadata.ts — small helper to build the AuditMetadata
 * envelope required by every state-changing tRPC mutation (Primitives §14).
 *
 * The orchestrator schema is `AuditMetadataInputSchema` in
 * @orbital/orchestrator. Browsers cannot import that runtime, so we mirror
 * the shape inline. If the schema ever drifts, the tRPC mutation will
 * surface a 400 with the missing-field name.
 *
 * Usage:
 *   buildAuditMetadata('User locked the vision document')
 *   buildAuditMetadata('Resume sprint X', { linked_artifacts: [{ type: 'sprint', id }] })
 */

interface UserActor {
  type: 'user'
  user_id: string
  install_id: string
}

export interface AuditMetadata {
  actor: UserActor
  justification: string
  trace_id: string
  capability_id?: string
  parent_event_id?: string
  linked_artifacts: Array<{ type: string; id: string }>
}

interface BuildOptions {
  /** Linked artifacts (event-history thread). Defaults to []. */
  linked_artifacts?: Array<{ type: string; id: string }>
  /** Override the user_id (used by onboarding wizard). Defaults to 'local-user'. */
  user_id?: string
  /** Override install_id. Defaults to 'web-ui'. */
  install_id?: string
}

/**
 * Build an AuditMetadata envelope for a UI-initiated mutation.
 *
 * - `actor` is always a `user` actor (UI runs in the user's browser).
 * - `trace_id` is a fresh UUIDv4 per call so audit reconstruction can
 *   correlate retries.
 * - `linked_artifacts` is optional but recommended where the action is
 *   already in the context of a known aggregate (sprint, vision, etc.).
 */
export function buildAuditMetadata(
  justification: string,
  opts: BuildOptions = {},
): AuditMetadata {
  if (!justification || !justification.trim()) {
    throw new Error('buildAuditMetadata: justification is required')
  }
  return {
    actor: {
      type: 'user',
      user_id: opts.user_id ?? 'local-user',
      install_id: opts.install_id ?? 'web-ui',
    },
    justification: justification.trim(),
    trace_id: crypto.randomUUID(),
    linked_artifacts: opts.linked_artifacts ?? [],
  }
}
