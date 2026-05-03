/**
 * CapabilityAuthority — issuance, verification, and revocation.
 *
 * Per TRD-06 §6.3 and §7.1.
 *
 * Every event is written through `EventStore.append`. Direct `db.insert(events)`
 * calls are forbidden by project rules and absent from this module.
 */
import { type CapabilityBundle, type Scopes, type Actor, type ScopeKey } from '@orbital/types';
import type { EventStore } from '../events/store.js';
import type { KeyManager } from './keys.js';
import { type ValidationResult } from './gateway.js';
import { type IssueContext } from './sod.js';
export interface IssueParams {
    install_id: string;
    persona_id: string;
    task_id: string;
    sprint_id: string;
    session_id: string;
    scopes: Scopes;
    /** Default = 30 minutes if unspecified. */
    ttl_ms?: number;
    /** Required on all issuances per Primitives §14. */
    justification: string;
    /** Explicit actor of the issuance (typically system: capability_authority). */
    actor: Actor;
    trace_id: string;
    /** Optional: SoD-related task context. */
    sod_context?: IssueContext;
    /** Optional override for `now` (test helper). */
    now?: Date;
}
export interface IssueResult {
    bundle: CapabilityBundle;
    capability_id: string;
}
export interface VerifyResult {
    ok: boolean;
    reason_code?: string;
    reason_detail?: string;
    bundle?: CapabilityBundle;
}
export interface RevokeParams {
    reason: 'task_complete' | 'task_failed' | 'task_cancelled' | 'admin_action' | 'emergency_rotation' | 'sprint_pause';
    reason_detail?: string;
    actor: Actor;
    trace_id: string;
}
export interface ICapabilityAuthority {
    issue(params: IssueParams): Promise<IssueResult>;
    verify(bundle: CapabilityBundle, now?: Date, opts?: {
        clockSkewMs?: number;
    }): Promise<VerifyResult>;
    revoke(capabilityId: string, params: RevokeParams): Promise<void>;
    hasScope(bundle: CapabilityBundle, scope: ScopeKey, resource: string): boolean;
    /**
     * Validate a tool call AND emit the corresponding CapabilityGranted /
     * CapabilityDenied event. Used by the MCP gateway in Phase 2B; until then
     * exposed for unit tests that assert event emission.
     */
    validateAndEmit(bundle: CapabilityBundle, toolName: string, params: Record<string, unknown>, actor: Actor, traceId: string): Promise<ValidationResult>;
}
export declare class CapabilityAuthority implements ICapabilityAuthority {
    private readonly eventStore;
    private readonly keyManager;
    constructor(eventStore: EventStore, keyManager: KeyManager);
    issue(params: IssueParams): Promise<IssueResult>;
    verify(bundle: CapabilityBundle, now?: Date, opts?: {
        clockSkewMs?: number;
    }): Promise<VerifyResult>;
    revoke(capabilityId: string, params: RevokeParams): Promise<void>;
    hasScope(bundle: CapabilityBundle, scope: ScopeKey, resource: string): boolean;
    validateAndEmit(bundle: CapabilityBundle, toolName: string, params: Record<string, unknown>, actor: Actor, traceId: string): Promise<ValidationResult>;
}
export type { IssueContext, SodViolation } from './sod.js';
//# sourceMappingURL=authority.d.ts.map