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
import type { Scopes, CapabilityBundle } from '@orbital/types';
export interface IssueContext {
    /** When the persona is `verifier`, this is the artifact under review. */
    verification_target?: string[];
    /** When the bundle's ceremony_role includes 'chair', participants of the same ceremony. */
    ceremony_participants?: string[];
    /** The persona being granted (for chair-vs-participant detection). */
    ceremony_self_id?: string;
}
export interface SodViolation {
    rule_id: string;
    description: string;
}
/**
 * Issue-time SoD check.
 *
 * Returns `null` if no violation, else the rule that fired.
 */
export declare function checkIssue(personaId: string, scopes: Scopes, ctx?: IssueContext): SodViolation | null;
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
export declare function checkRuntime(bundle: CapabilityBundle, tool: string, params: Record<string, unknown>): SodViolation | null;
//# sourceMappingURL=sod.d.ts.map