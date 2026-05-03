/**
 * In-tree default capability policy.
 *
 * This is the source of truth for the v1 default policy. The user-facing
 * file at `config/capability-policy.default.ts` re-exports from here so the
 * default ships with Orbital at runtime AND lives under the orchestrator's
 * TypeScript rootDir for type-checking and bundling.
 *
 * Per TRD-06 §13.1, admins customize the policy by editing
 * `~/.orbital/config/capability-policy.ts`; the compiler step then persists
 * the runtime form to `capability_policies`.
 */
import type { ScopeKey } from '@orbital/types';
export interface PersonaDefault {
    files_read: string[];
    files_write: string[];
    board_read: string[];
    board_mutate: string[];
    channel_read: string[];
    channel_post: string[];
    secrets: string[];
    network_egress: string[];
    spawn_subagent: boolean;
    git_commit: Array<{
        branch: string;
        paths: string[];
    }>;
    ceremony_role: Array<'chair' | 'participant' | 'observer'>;
}
export interface PolicyProhibition {
    scopeKey: ScopeKey;
    pattern: string;
}
export interface SodRule {
    id: string;
    description: string;
    applies_to_persona: string[];
    forbidden_scope_combinations: Array<{
        when_holds: {
            scopeKey: ScopeKey;
            pattern: string;
        };
        forbids: {
            scopeKey: ScopeKey;
            pattern: string;
        };
    }>;
    forbidden_in_default_profile: Array<{
        scopeKey: ScopeKey;
        pattern?: string;
    }>;
}
export interface CapabilityPolicy {
    version: number;
    defaults: Record<string, PersonaDefault>;
    modifiers: Record<string, unknown>;
    prohibitions: PolicyProhibition[];
    sod_rules: SodRule[];
}
export declare const DEFAULT_SOD_RULES: SodRule[];
export declare const DEFAULT_PROHIBITIONS: PolicyProhibition[];
export declare const DEFAULT_PERSONA_DEFAULTS: Record<string, PersonaDefault>;
export declare const DEFAULT_CAPABILITY_POLICY: CapabilityPolicy;
//# sourceMappingURL=default-policy.d.ts.map