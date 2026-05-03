/**
 * Gateway validation function — `validateToolCall(bundle, toolName, params)`.
 *
 * Per TRD-06 §6.2.2 (matchScope) and §6.2.3 (tool-to-scope map).
 *
 * Pure function: no DB access, no event emission. The MCP gateway (Phase 2B)
 * is responsible for emitting `CapabilityGranted` on success or `CapabilityDenied`
 * on failure using the data this function returns.
 *
 * The bundle is the entire grant: a malicious prompt cannot inject scope.
 */
import type { CapabilityBundle, ScopeKey } from '@orbital/types';
/** Defense-in-depth path deny list. Always rejected, regardless of policy. */
export declare const PATH_HARD_DENY: string[];
export interface ValidationAllow {
    allowed: true;
    matched_scope: ScopeKey;
    matched_pattern: string;
}
export interface ValidationDeny {
    allowed: false;
    reason_code: string;
    reason_detail: string;
    attempted_target: string;
}
export type ValidationResult = ValidationAllow | ValidationDeny;
/** Mapping from MCP tool name to the scope key the validator must check. */
export declare const TOOL_TO_SCOPE_KEY: Record<string, ScopeKey>;
/** Extract a human-readable target string from tool params for diagnostics. */
export declare function extractTarget(_toolName: string, params: Record<string, unknown>): string;
/**
 * The main entry point. Returns `{ allowed: true }` or `{ allowed: false, ... }`.
 * Never throws on a denial — only on internal logic errors.
 */
export declare function validateToolCall(bundle: CapabilityBundle, toolName: string, params: Record<string, unknown>): ValidationResult;
export declare function scopeKeyForTool(toolName: string): ScopeKey | undefined;
/**
 * Validate `channel_read` or `channel_post` against a single channel name.
 * Used by tools whose params carry an array of channels — they iterate and
 * call this per channel.
 */
export declare function gatewayValidateChannel(bundle: CapabilityBundle, scope: 'channel_read' | 'channel_post', channelName: string): boolean;
//# sourceMappingURL=gateway.d.ts.map