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
// ---------------------------------------------------------------------------
// SoD rules (TRD-06 §12.2)
// ---------------------------------------------------------------------------
export const DEFAULT_SOD_RULES = [
    {
        id: 'sod_dev_no_approve',
        description: 'Developer personas cannot grant approval (board_mutate to *.approval_status / *.review_decision).',
        applies_to_persona: ['senior-developer', 'junior-developer', 'staff-developer', 'principal-developer'],
        forbidden_scope_combinations: [],
        forbidden_in_default_profile: [
            { scopeKey: 'board_mutate', pattern: '*.approval_status' },
            { scopeKey: 'board_mutate', pattern: '*.review_decision' },
        ],
    },
    {
        id: 'sod_verifier_no_artifact_write',
        description: 'Verifier persona cannot write to the artifact under verification. files_write must be empty for verifier defaults; runtime check enforces no overlap with verification target.',
        applies_to_persona: ['verifier'],
        forbidden_scope_combinations: [],
        forbidden_in_default_profile: [
            { scopeKey: 'files_write' },
            { scopeKey: 'git_commit' },
        ],
    },
    {
        id: 'sod_no_self_revocation',
        description: 'No persona may have board_mutate on capability:* (would allow self-revoke).',
        applies_to_persona: ['*'],
        forbidden_scope_combinations: [],
        forbidden_in_default_profile: [
            { scopeKey: 'board_mutate', pattern: 'capability:*' },
        ],
    },
    {
        id: 'sod_retro_no_apply',
        description: 'Retro persona proposes; user approves; retro cannot apply changes itself (no files_write on config/**).',
        applies_to_persona: ['retro', 'retro-analyst'],
        forbidden_scope_combinations: [],
        forbidden_in_default_profile: [
            { scopeKey: 'files_write', pattern: 'config/**' },
        ],
    },
    {
        id: 'sod_ceremony_chair_not_participant',
        description: 'Ceremony chair persona must not also be in the participant list of the same ceremony. Enforced at issue time when both ceremony_role and participant context are present.',
        applies_to_persona: ['*'],
        forbidden_scope_combinations: [],
        forbidden_in_default_profile: [],
    },
];
// ---------------------------------------------------------------------------
// Hard prohibitions — never overridable, even by an admin policy update.
// ---------------------------------------------------------------------------
export const DEFAULT_PROHIBITIONS = [
    // No wildcard secrets ever.
    { scopeKey: 'secrets', pattern: '*' },
    // No writes anywhere a secret might live.
    { scopeKey: 'files_write', pattern: '**/secrets/**' },
    { scopeKey: 'files_write', pattern: '**/*.pem' },
    { scopeKey: 'files_write', pattern: '**/*.key' },
    { scopeKey: 'files_write', pattern: '.env*' },
    // No wildcard network egress.
    { scopeKey: 'network_egress', pattern: '*' },
];
// ---------------------------------------------------------------------------
// Default per-persona scopes (sketched; expanded in Phase 2A persona library)
// ---------------------------------------------------------------------------
const EMPTY_DEFAULT = {
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
};
export const DEFAULT_PERSONA_DEFAULTS = {
    'senior-developer': {
        ...EMPTY_DEFAULT,
        files_read: ['src/**', '!src/**/secrets/**'],
        files_write: [],
        board_read: ['ticket:*'],
        board_mutate: ['ticket:*.status'],
        channel_read: ['#sprint-*', '#orb-*', '#architecture-decisions'],
        channel_post: ['#orb-*', '#sprint-*'],
        network_egress: ['api.anthropic.com'],
    },
    'junior-developer': {
        ...EMPTY_DEFAULT,
        files_read: ['src/**', '!src/**/secrets/**'],
        files_write: [],
        board_read: ['ticket:*'],
        board_mutate: ['ticket:*.status'],
        channel_read: ['#sprint-*', '#orb-*'],
        channel_post: ['#orb-*'],
        network_egress: ['api.anthropic.com'],
    },
    verifier: {
        ...EMPTY_DEFAULT,
        files_read: ['src/**'],
        files_write: [],
        board_read: ['ticket:*'],
        board_mutate: ['ticket:*.verification_record'],
        channel_read: ['#orb-*'],
        channel_post: ['#orb-*'],
        network_egress: ['api.anthropic.com'],
    },
    'retro-analyst': {
        ...EMPTY_DEFAULT,
        files_read: ['src/**'],
        files_write: [],
        board_read: ['*'],
        channel_read: ['#sprint-*', '#retro-*'],
        channel_post: ['#retro-*'],
        network_egress: ['api.anthropic.com'],
    },
};
// ---------------------------------------------------------------------------
// Top-level export
// ---------------------------------------------------------------------------
export const DEFAULT_CAPABILITY_POLICY = {
    version: 1,
    defaults: DEFAULT_PERSONA_DEFAULTS,
    modifiers: {},
    prohibitions: DEFAULT_PROHIBITIONS,
    sod_rules: DEFAULT_SOD_RULES,
};
export default DEFAULT_CAPABILITY_POLICY;
//# sourceMappingURL=capability-policy.default.js.map