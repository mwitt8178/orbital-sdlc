/**
 * Separation-of-Duties enforcer.
 *
 * Per TRD-06 §12 and §6.2.1 Step H. SoD is checked twice:
 *   1. At issue time: `checkIssue(personaId, scopes, taskCtx)` — rejects with
 *      AUTH_SOD_VIOLATION before signing.
 *   2. At runtime: `checkRuntime(bundle, tool, params)` — rejects per-call
 *      actions that violate task-specific SoD invariants. Most SoD rules are
 *      static (covered by issue-time); the verifier-no-artifact-write rule is
 *      the canonical runtime-only check because the artifact under verification
 *      is task-specific.
 */

import micromatch from 'micromatch'
import type { Scopes, ScopeKey, CapabilityBundle } from '@orbital/types'
import { getActivePolicy, type SodRule } from './policy.js'

export interface IssueContext {
  /** When the persona is `verifier`, this is the artifact under review. */
  verification_target?: string[]
  /** When the bundle's ceremony_role includes 'chair', participants of the same ceremony. */
  ceremony_participants?: string[]
  /** The persona being granted (for chair-vs-participant detection). */
  ceremony_self_id?: string
}

export interface SodViolation {
  rule_id: string
  description: string
}

/**
 * Issue-time SoD check.
 *
 * Returns `null` if no violation, else the rule that fired.
 */
export function checkIssue(
  personaId: string,
  scopes: Scopes,
  ctx: IssueContext = {},
): SodViolation | null {
  const policy = getActivePolicy()

  for (const rule of policy.sod_rules) {
    if (!appliesTo(rule, personaId)) continue

    // Forbidden default profile entries.
    for (const f of rule.forbidden_in_default_profile) {
      const list = scopes[f.scopeKey]
      if (f.pattern === undefined) {
        // Forbid the whole scope key being non-empty / true.
        if (Array.isArray(list)) {
          if (list.length > 0) {
            return { rule_id: rule.id, description: rule.description }
          }
        } else if (typeof list === 'boolean') {
          if (list) {
            return { rule_id: rule.id, description: rule.description }
          }
        }
      } else {
        // Forbid this specific pattern.
        if (Array.isArray(list)) {
          for (const item of list) {
            if (typeof item === 'string' && (item === f.pattern || matchesPattern(item, f.pattern))) {
              return { rule_id: rule.id, description: rule.description }
            }
          }
        }
      }
    }

    // Forbidden combinations.
    for (const combo of rule.forbidden_scope_combinations) {
      if (
        scopeListIncludes(scopes, combo.when_holds.scopeKey, combo.when_holds.pattern) &&
        scopeListIncludes(scopes, combo.forbids.scopeKey, combo.forbids.pattern)
      ) {
        return { rule_id: rule.id, description: rule.description }
      }
    }
  }

  // Verifier rule (static at issue time): if persona is verifier and any
  // verification_target globs intersect files_write — reject.
  if (personaId === 'verifier' && ctx.verification_target) {
    for (const target of ctx.verification_target) {
      for (const writePat of scopes.files_write) {
        if (micromatch.isMatch(target, writePat) || micromatch.isMatch(writePat, target)) {
          return {
            rule_id: 'sod_verifier_no_artifact_write',
            description: 'verifier files_write overlaps verification target',
          }
        }
      }
    }
  }

  // Ceremony chair rule: if scopes.ceremony_role includes 'chair' and the
  // ceremony_self_id appears in ceremony_participants → reject.
  if (
    scopes.ceremony_role.includes('chair') &&
    ctx.ceremony_self_id &&
    ctx.ceremony_participants &&
    ctx.ceremony_participants.includes(ctx.ceremony_self_id)
  ) {
    return {
      rule_id: 'sod_ceremony_chair_not_participant',
      description: 'chair persona is also in the participant list of the same ceremony',
    }
  }

  return null
}

/**
 * Runtime SoD check at the gateway.
 *
 * Returns `null` if no violation. The verifier-no-artifact-write rule is the
 * canonical runtime-only check; it depends on the bundle's task-specific
 * verification target which the issuer encodes into payload via the issuer.
 *
 * For now we re-evaluate file_write writes vs files_read paths for verifier
 * personas: a verifier should have files_write empty; if it ever attempts
 * a write to a path inside its own files_read scope, deny.
 */
export function checkRuntime(
  bundle: CapabilityBundle,
  tool: string,
  params: Record<string, unknown>,
): SodViolation | null {
  // Verifier writing to a path it can read = SoD violation.
  if (
    bundle.persona_id === 'verifier' &&
    (tool === 'files.write' || tool === 'files.append' || tool === 'files.delete')
  ) {
    const target = typeof params['path'] === 'string' ? params['path'] : ''
    if (target) {
      for (const readPat of bundle.scopes.files_read) {
        if (micromatch.isMatch(target, readPat)) {
          return {
            rule_id: 'sod_verifier_no_artifact_write',
            description: `verifier attempted write to readable path ${target}`,
          }
        }
      }
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function appliesTo(rule: SodRule, personaId: string): boolean {
  if (rule.applies_to_persona.includes('*')) return true
  return rule.applies_to_persona.includes(personaId)
}

function scopeListIncludes(scopes: Scopes, key: ScopeKey, pattern: string): boolean {
  const list = scopes[key]
  if (Array.isArray(list)) {
    return list.some((item) => typeof item === 'string' && item === pattern)
  }
  if (typeof list === 'boolean') {
    return list && pattern === 'true'
  }
  return false
}

function matchesPattern(grantedPattern: string, forbiddenPattern: string): boolean {
  // Treat the forbidden pattern as a glob to test against the granted literal.
  // Example: granted='ticket:ORB-237.approval_status', forbidden='*.approval_status'.
  return micromatch.isMatch(grantedPattern, forbiddenPattern)
}
