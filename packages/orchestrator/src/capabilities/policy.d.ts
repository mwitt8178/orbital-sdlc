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
import { type CapabilityPolicy, type PersonaDefault, type PolicyProhibition, type SodRule } from './default-policy.js';
export interface CompiledPolicy {
    version: number;
    source_hash: string;
    defaults: Record<string, PersonaDefault>;
    modifiers: Record<string, unknown>;
    prohibitions: PolicyProhibition[];
    sod_rules: SodRule[];
}
/** Compile a policy: validate, hash, return runtime form. */
export declare function compilePolicy(policy: CapabilityPolicy): CompiledPolicy;
/** Load the active runtime policy. v1: returns the in-process default. */
export declare function getActivePolicy(): CompiledPolicy;
/** Replace the active policy. Used by the policies.update flow (Phase 6+). */
export declare function setActivePolicy(policy: CapabilityPolicy): CompiledPolicy;
/** Reset for tests. */
export declare function resetPolicyCache(): void;
/** Get the default profile for a persona, or an empty default. */
export declare function getPersonaDefault(personaId: string): PersonaDefault;
export type { CapabilityPolicy, PersonaDefault, PolicyProhibition, SodRule };
//# sourceMappingURL=policy.d.ts.map