/**
 * Default capability policy shipped with Orbital.
 *
 * Per TRD-06 §13.1 and SAO §5.4. The runtime form lives in the
 * `capability_policies` table; this file is the source of truth that the
 * compiler reads, validates against the prohibitions list, and persists.
 *
 * v1: defaults are deliberately conservative. Personas only get scopes they
 * demonstrably need. Anything beyond defaults must be requested at issue
 * time via narrowed overrides.
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
    /** Forbidden combinations of scopes within a single bundle. */
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
    /** Scopes/patterns that may not appear in the persona's default profile. */
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
export default DEFAULT_CAPABILITY_POLICY;
//# sourceMappingURL=capability-policy.default.d.ts.map