/**
 * Default capability policy shipped with Orbital.
 *
 * This file re-exports the canonical default from the orchestrator package
 * so that:
 *   - The runtime defaults remain a single source of truth
 *     (`packages/orchestrator/src/capabilities/default-policy.ts`).
 *   - Users browsing `config/` can still see the policy structure they may
 *     override at `~/.orbital/config/capability-policy.ts`.
 *
 * Per TRD-06 §13.1: admins customize by editing the runtime file at
 * `~/.orbital/config/capability-policy.ts`, then submitting via the
 * `policies.update` tRPC procedure.
 */

export {
  DEFAULT_CAPABILITY_POLICY,
  DEFAULT_PERSONA_DEFAULTS,
  DEFAULT_PROHIBITIONS,
  DEFAULT_SOD_RULES,
  type CapabilityPolicy,
  type PersonaDefault,
  type PolicyProhibition,
  type SodRule,
} from '../packages/orchestrator/src/capabilities/default-policy.js'

import { DEFAULT_CAPABILITY_POLICY } from '../packages/orchestrator/src/capabilities/default-policy.js'

export default DEFAULT_CAPABILITY_POLICY
