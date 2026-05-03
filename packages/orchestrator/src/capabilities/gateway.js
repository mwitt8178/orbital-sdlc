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
import micromatch from 'micromatch';
import path from 'node:path';
import { checkRuntime as sodCheckRuntime } from './sod.js';
/** Defense-in-depth path deny list. Always rejected, regardless of policy. */
export const PATH_HARD_DENY = [
    '**/secrets/**',
    '**/*.pem',
    '**/*.key',
    '.env*',
    '**/.env*',
    '**/.aws/**',
    '**/.ssh/**',
];
/** Mapping from MCP tool name to the scope key the validator must check. */
export const TOOL_TO_SCOPE_KEY = {
    'files.read': 'files_read',
    'files.list': 'files_read',
    'files.stat': 'files_read',
    'files.write': 'files_write',
    'files.append': 'files_write',
    'files.delete': 'files_write',
    'files.rename': 'files_write',
    'secrets.read': 'secrets',
    'network.fetch': 'network_egress',
    'network.post': 'network_egress',
    'board.read': 'board_read',
    'ticket.read': 'board_read',
    'board.mutate': 'board_mutate',
    'ticket.update': 'board_mutate',
    'ticket.transition': 'board_mutate',
    'channel.read': 'channel_read',
    'channel.posts.read': 'channel_read',
    // 'inbox.subscribe' / 'inbox.read_since' map here for diagnostics + gateway
    // single-channel checks. The actual tool handlers run with bypassScopeCheck=true
    // because they accept ARRAYS of channels and must validate each one
    // individually via gatewayValidateChannel().
    'inbox.subscribe': 'channel_read',
    'inbox.read_since': 'channel_read',
    'channel.subscribe': 'channel_read',
    'channel.post': 'channel_post',
    'channel.reply': 'channel_post',
    'channel.thread.reply': 'channel_post',
    'channel.cross_post': 'channel_post',
    'channel.post.pin': 'channel_post',
    'channel.post.react': 'channel_read',
    'blocker.raise': 'channel_post',
    'git.sign_commit': 'git_commit',
    'agent.spawn_subagent': 'spawn_subagent',
    'ceremony.statement': 'ceremony_role',
    'ceremony.call_closure': 'ceremony_role',
    'ceremony.cast_vote': 'ceremony_role',
    'ceremony.write_output': 'ceremony_role',
};
/** Extract a human-readable target string from tool params for diagnostics. */
export function extractTarget(_toolName, params) {
    if (typeof params['path'] === 'string')
        return params['path'];
    if (typeof params['channel'] === 'string')
        return params['channel'];
    if (typeof params['target'] === 'string')
        return params['target'];
    if (typeof params['url'] === 'string')
        return params['url'];
    if (typeof params['host'] === 'string')
        return params['host'];
    if (typeof params['secret_key'] === 'string')
        return params['secret_key'];
    return _toolName;
}
/**
 * The main entry point. Returns `{ allowed: true }` or `{ allowed: false, ... }`.
 * Never throws on a denial — only on internal logic errors.
 */
export function validateToolCall(bundle, toolName, params) {
    const scopeKey = TOOL_TO_SCOPE_KEY[toolName];
    const target = extractTarget(toolName, params);
    if (!scopeKey) {
        return {
            allowed: false,
            reason_code: 'AUTH_UNKNOWN_TOOL',
            reason_detail: `tool '${toolName}' is not in the allow-list`,
            attempted_target: target,
        };
    }
    // Step F: scope match.
    const matched = matchScope(scopeKey, params, bundle.scopes);
    if (!matched) {
        return {
            allowed: false,
            reason_code: 'AUTH_SCOPE_DENIED',
            reason_detail: `no granted ${scopeKey} pattern matches '${target}'`,
            attempted_target: target,
        };
    }
    // Step G: hard prohibitions (defense in depth).
    if (violatesHardProhibition(scopeKey, params)) {
        return {
            allowed: false,
            reason_code: 'AUTH_POLICY_PROHIBITED',
            reason_detail: `hard prohibition triggered for ${scopeKey}:${target}`,
            attempted_target: target,
        };
    }
    // Step H: runtime SoD.
    const sod = sodCheckRuntime(bundle, toolName, params);
    if (sod) {
        return {
            allowed: false,
            reason_code: 'AUTH_SOD_VIOLATION',
            reason_detail: `${sod.rule_id}: ${sod.description}`,
            attempted_target: target,
        };
    }
    return {
        allowed: true,
        matched_scope: matched.matched_scope,
        matched_pattern: matched.matched_pattern,
    };
}
function matchScope(scopeKey, params, scopes) {
    switch (scopeKey) {
        case 'files_read':
        case 'files_write': {
            const raw = stringParam(params, 'path');
            if (!raw)
                return null;
            const norm = normalizeRepoPath(raw);
            if (!norm)
                return null;
            // Hard deny first.
            if (PATH_HARD_DENY.some((p) => micromatch.isMatch(norm, p, { dot: true })))
                return null;
            const list = scopes[scopeKey];
            const matched = list.find((p) => micromatch.isMatch(norm, p, { dot: true }));
            return matched ? { matched_scope: scopeKey, matched_pattern: matched } : null;
        }
        case 'secrets': {
            const key = stringParam(params, 'secret_key');
            if (!key)
                return null;
            // Wildcards in the GRANT list are forbidden — defensive check.
            if (scopes.secrets.some((s) => s.includes('*')))
                return null;
            // Wildcards in the REQUEST are also rejected (treated as not-matching).
            if (key.includes('*'))
                return null;
            return scopes.secrets.includes(key)
                ? { matched_scope: 'secrets', matched_pattern: key }
                : null;
        }
        case 'network_egress': {
            const url = stringParam(params, 'url');
            const explicitHost = stringParam(params, 'host');
            let host;
            if (url) {
                try {
                    host = new URL(url).hostname;
                }
                catch {
                    return null;
                }
            }
            else if (explicitHost) {
                host = explicitHost;
            }
            else {
                return null;
            }
            const matched = scopes.network_egress.find((p) => hostMatches(host, p));
            return matched
                ? { matched_scope: 'network_egress', matched_pattern: matched }
                : null;
        }
        case 'board_read':
        case 'board_mutate': {
            const target = stringParam(params, 'target');
            if (!target)
                return null;
            const field = stringParam(params, 'field');
            const matched = matchBoard(scopes[scopeKey], target, field);
            return matched
                ? { matched_scope: scopeKey, matched_pattern: matched }
                : null;
        }
        case 'channel_read':
        case 'channel_post': {
            const channel = stringParam(params, 'channel');
            if (!channel)
                return null;
            const matched = scopes[scopeKey].find((p) => channelMatches(channel, p));
            return matched
                ? { matched_scope: scopeKey, matched_pattern: matched }
                : null;
        }
        case 'spawn_subagent': {
            return scopes.spawn_subagent
                ? { matched_scope: 'spawn_subagent', matched_pattern: 'true' }
                : null;
        }
        case 'git_commit': {
            const branch = stringParam(params, 'branch');
            const pathsRaw = params['paths'];
            if (!branch || !Array.isArray(pathsRaw))
                return null;
            const paths = pathsRaw.filter((p) => typeof p === 'string');
            const matched = scopes.git_commit.find((rule) => micromatch.isMatch(branch, rule.branch) &&
                paths.every((p) => rule.paths.some((g) => micromatch.isMatch(p, g))));
            return matched
                ? {
                    matched_scope: 'git_commit',
                    matched_pattern: `${matched.branch}::${matched.paths.join(',')}`,
                }
                : null;
        }
        case 'ceremony_role': {
            const required = stringParam(params, 'required_role');
            if (!required)
                return null;
            // Hierarchy: chair > participant > observer. A chair can act as participant; observer is read-only.
            const hierarchy = {
                chair: ['chair', 'participant', 'observer'],
                participant: ['participant', 'observer'],
                observer: ['observer'],
            };
            for (const role of scopes.ceremony_role) {
                const allowed = hierarchy[role] ?? [];
                if (allowed.includes(required)) {
                    return { matched_scope: 'ceremony_role', matched_pattern: role };
                }
            }
            return null;
        }
    }
}
function violatesHardProhibition(scopeKey, params) {
    if (scopeKey === 'secrets') {
        const k = stringParam(params, 'secret_key');
        if (k && k.includes('*'))
            return true;
    }
    if (scopeKey === 'network_egress') {
        const url = stringParam(params, 'url');
        const host = stringParam(params, 'host') ?? (url ? safeHost(url) : null);
        if (host && host === '*')
            return true;
    }
    return false;
}
// ---------------------------------------------------------------------------
// Pattern helpers
// ---------------------------------------------------------------------------
function safeHost(u) {
    try {
        return new URL(u).hostname;
    }
    catch {
        return null;
    }
}
function hostMatches(host, pattern) {
    if (pattern === '*')
        return false; // wildcard egress is hard-denied
    if (pattern === host)
        return true;
    if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(1); // '.example.com'
        return host.endsWith(suffix) && host.length > suffix.length;
    }
    return false;
}
function channelMatches(channel, pattern) {
    if (pattern === channel)
        return true;
    if (pattern.endsWith('*')) {
        const prefix = pattern.slice(0, -1);
        return channel.startsWith(prefix);
    }
    return micromatch.isMatch(channel, pattern);
}
function matchBoard(patterns, target, field) {
    // Patterns: 'ticket:<id>' | 'epic:<id>' | '*' [optional '.<field>' qualifier]
    for (const p of patterns) {
        if (p === '*')
            return p;
        // 'ticket:ORB-237' matches target='ticket:ORB-237' regardless of field.
        if (p === target && !field)
            return p;
        // 'ticket:ORB-237.status' matches target='ticket:ORB-237' field='status'.
        if (field && p === `${target}.${field}`)
            return p;
        // 'ticket:*' wildcard.
        if (p.endsWith(':*')) {
            const prefix = p.slice(0, -1);
            if (target.startsWith(prefix))
                return p;
        }
        // 'ticket:*.status' wildcard with field.
        if (p.includes(':*.') && field) {
            const [colon, pField] = p.split(':*.');
            if (colon !== undefined && pField !== undefined && target.startsWith(`${colon}:`) && pField === field) {
                return p;
            }
        }
    }
    return null;
}
/**
 * Normalize a path to a repo-relative POSIX path.
 * Returns null if the path escapes the repo root (e.g. '..', '/etc/passwd')
 * or if the path is otherwise unsafe.
 */
function normalizeRepoPath(p) {
    // Reject absolute paths outside repo (we don't know repo root here, but we
    // can reject anything starting with `/` — workers should pass repo-relative).
    if (p.startsWith('/') || /^[a-zA-Z]:/.test(p))
        return null;
    // Reject paths with `..` after normalization.
    const normalized = path.posix.normalize(p);
    if (normalized.startsWith('..') || normalized.includes('/../'))
        return null;
    return normalized;
}
function stringParam(params, key) {
    const v = params[key];
    return typeof v === 'string' ? v : null;
}
// ---------------------------------------------------------------------------
// Reverse map for diagnostics
// ---------------------------------------------------------------------------
export function scopeKeyForTool(toolName) {
    return TOOL_TO_SCOPE_KEY[toolName];
}
// ---------------------------------------------------------------------------
// Multi-channel scope helpers (used by tools whose params accept an array of
// channels: inbox.subscribe / inbox.read_since)
// ---------------------------------------------------------------------------
/**
 * Validate `channel_read` or `channel_post` against a single channel name.
 * Used by tools whose params carry an array of channels — they iterate and
 * call this per channel.
 */
export function gatewayValidateChannel(bundle, scope, channelName) {
    const tool = scope === 'channel_read' ? 'channel.read' : 'channel.post';
    const result = validateToolCall(bundle, tool, { channel: channelName });
    return result.allowed;
}
//# sourceMappingURL=gateway.js.map