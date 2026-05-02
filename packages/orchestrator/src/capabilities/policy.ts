/**
 * Runtime policy loader.
 *
 * Per TRD-06 §13: the TS source is the source of truth; the compiled form
 * is persisted to `capability_policies` for fast lookup.
 *
 * v1: ships with a default policy in `config/capability-policy.default.ts`
 * which is loaded at boot. Admin updates (UC-015) are implemented in a
 * later phase via `policies.update` tRPC procedure; this loader exposes
 * the data structures used by `authority.ts` and `sod.ts`.
 */

import { createHash } from 'node:crypto'
import {
  DEFAULT_CAPABILITY_POLICY,
  type CapabilityPolicy,
  type PersonaDefault,
  type PolicyProhibition,
  type SodRule,
} from './default-policy.js'

let cached: CompiledPolicy | null = null

export interface CompiledPolicy {
  version: number
  source_hash: string
  defaults: Record<string, PersonaDefault>
  modifiers: Record<string, unknown>
  prohibitions: PolicyProhibition[]
  sod_rules: SodRule[]
}

/** Compile a policy: validate, hash, return runtime form. */
export function compilePolicy(policy: CapabilityPolicy): CompiledPolicy {
  // Hard validation: any default that grants a prohibited pattern is rejected.
  for (const [persona, def] of Object.entries(policy.defaults)) {
    for (const proh of policy.prohibitions) {
      const list = def[proh.scopeKey]
      if (Array.isArray(list)) {
        for (const granted of list) {
          if (typeof granted === 'string' && granted === proh.pattern) {
            throw new Error(
              `VALIDATION_POLICY_PROHIBITION_VIOLATION: persona '${persona}' grants prohibited '${proh.scopeKey}: ${proh.pattern}'`,
            )
          }
        }
      }
    }
  }

  // Hard validation: secrets MUST NEVER include a wildcard.
  for (const [persona, def] of Object.entries(policy.defaults)) {
    for (const s of def.secrets) {
      if (s.includes('*')) {
        throw new Error(
          `VALIDATION_POLICY_PROHIBITION_VIOLATION: persona '${persona}' has wildcard in secrets: ${s}`,
        )
      }
    }
  }

  const source_hash = createHash('sha256')
    .update(JSON.stringify(policy), 'utf8')
    .digest('hex')

  return {
    version: policy.version,
    source_hash,
    defaults: policy.defaults,
    modifiers: policy.modifiers,
    prohibitions: policy.prohibitions,
    sod_rules: policy.sod_rules,
  }
}

/** Load the active runtime policy. v1: returns the in-process default. */
export function getActivePolicy(): CompiledPolicy {
  if (cached) return cached
  cached = compilePolicy(DEFAULT_CAPABILITY_POLICY)
  return cached
}

/** Replace the active policy. Used by the policies.update flow (Phase 6+). */
export function setActivePolicy(policy: CapabilityPolicy): CompiledPolicy {
  cached = compilePolicy(policy)
  return cached
}

/** Reset for tests. */
export function resetPolicyCache(): void {
  cached = null
}

/** Get the default profile for a persona, or an empty default. */
export function getPersonaDefault(personaId: string): PersonaDefault {
  const p = getActivePolicy()
  const found = p.defaults[personaId]
  if (found) return found
  return {
    files_read: [],
    files_write: [],
    board_read: [],
    board_mutate: [],
    channel_read: [],
    channel_post: [],
    secrets: [],
    network_egress: [],
    spawn_subagent: false,
    git_commit: [],
    ceremony_role: [],
  }
}

export type { CapabilityPolicy, PersonaDefault, PolicyProhibition, SodRule }
