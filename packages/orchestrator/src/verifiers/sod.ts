/**
 * verifiers/sod.ts — SoD checks specific to the Verifier workflow.
 *
 * Per TRD-09 §10.6 and task spec:
 * - Verifier persona_id must differ from the task's executing persona_id.
 * - Enforced at spawnVerifier time (issue-time check) via CapabilityAuthority.
 * - Belt-and-braces: also enforced here in the verifier spawn path independently.
 *
 * The CapabilityAuthority.issue already checks the global SoD policy from
 * capabilities/sod.ts. This module provides the verifier-specific helper used
 * by VerifierService to reject before even attempting capability issuance.
 */

import { OrbitalError } from '@orbital/types'

export interface VerifierSodContext {
  /** The persona_id of the verifier being spawned (typically 'verifier'). */
  verifierPersonaId: string
  /** The persona_id of the agent that completed the task being verified. */
  actingPersonaId: string
}

export interface VerifierSodViolation {
  rule_id: string
  description: string
}

/**
 * Check whether the verifier spawn would violate SoD.
 *
 * Returns null if no violation; returns the violation descriptor otherwise.
 */
export function checkVerifierSod(ctx: VerifierSodContext): VerifierSodViolation | null {
  if (ctx.verifierPersonaId === ctx.actingPersonaId) {
    return {
      rule_id: 'sod_verifier_distinct_from_executor',
      description: `verifier persona '${ctx.verifierPersonaId}' must differ from the task executor '${ctx.actingPersonaId}'`,
    }
  }
  return null
}

/**
 * Assert SoD or throw.
 * Used by VerifierService.spawnVerifier — throws OrbitalError(AUTH_SOD_VIOLATION) on failure.
 */
export function assertVerifierSod(ctx: VerifierSodContext): void {
  const violation = checkVerifierSod(ctx)
  if (violation) {
    throw new OrbitalError(
      'AUTH_SOD_VIOLATION',
      `${violation.rule_id}: ${violation.description}`,
      { rule_id: violation.rule_id },
    )
  }
}
