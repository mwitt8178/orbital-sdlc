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

import type { ScopeKey } from '@orbital/types'

export interface PersonaDefault {
  files_read: string[]
  files_write: string[]
  board_read: string[]
  board_mutate: string[]
  channel_read: string[]
  channel_post: string[]
  secrets: string[]
  network_egress: string[]
  spawn_subagent: boolean
  git_commit: Array<{ branch: string; paths: string[] }>
  ceremony_role: Array<'chair' | 'participant' | 'observer'>
}

export interface PolicyProhibition {
  scopeKey: ScopeKey
  pattern: string
}

export interface SodRule {
  id: string
  description: string
  applies_to_persona: string[]
  forbidden_scope_combinations: Array<{
    when_holds: { scopeKey: ScopeKey; pattern: string }
    forbids: { scopeKey: ScopeKey; pattern: string }
  }>
  forbidden_in_default_profile: Array<{ scopeKey: ScopeKey; pattern?: string }>
}

export interface CapabilityPolicy {
  version: number
  defaults: Record<string, PersonaDefault>
  modifiers: Record<string, unknown>
  prohibitions: PolicyProhibition[]
  sod_rules: SodRule[]
}

// ---------------------------------------------------------------------------
// SoD rules (TRD-06 §12.2)
// ---------------------------------------------------------------------------

export const DEFAULT_SOD_RULES: SodRule[] = [
  {
    id: 'sod_dev_no_approve',
    description:
      'Developer personas cannot grant approval (board_mutate to *.approval_status / *.review_decision).',
    applies_to_persona: [
      'senior-developer',
      'junior-developer',
      'staff-developer',
      'principal-developer',
    ],
    forbidden_scope_combinations: [],
    forbidden_in_default_profile: [
      { scopeKey: 'board_mutate', pattern: '*.approval_status' },
      { scopeKey: 'board_mutate', pattern: '*.review_decision' },
    ],
  },
  {
    id: 'sod_verifier_no_artifact_write',
    description:
      'Verifier persona cannot write to the artifact under verification. files_write must be empty for verifier defaults; runtime check enforces no overlap with verification target.',
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
    forbidden_in_default_profile: [{ scopeKey: 'board_mutate', pattern: 'capability:*' }],
  },
  {
    id: 'sod_retro_no_apply',
    description:
      'Retro persona proposes; user approves; retro cannot apply changes itself (no files_write at all - asserted at issue-time per Phase 5B brief).',
    applies_to_persona: ['retro', 'retro-analyst'],
    forbidden_scope_combinations: [],
    forbidden_in_default_profile: [
      { scopeKey: 'files_write' },
      { scopeKey: 'git_commit' },
    ],
  },
  {
    id: 'sod_ceremony_chair_not_participant',
    description:
      'Ceremony chair persona must not also be in the participant list of the same ceremony. Enforced at issue time when both ceremony_role and participant context are present.',
    applies_to_persona: ['*'],
    forbidden_scope_combinations: [],
    forbidden_in_default_profile: [],
  },
]

// ---------------------------------------------------------------------------
// Hard prohibitions — never overridable, even by an admin policy update.
// ---------------------------------------------------------------------------

export const DEFAULT_PROHIBITIONS: PolicyProhibition[] = [
  { scopeKey: 'secrets', pattern: '*' },
  { scopeKey: 'files_write', pattern: '**/secrets/**' },
  { scopeKey: 'files_write', pattern: '**/*.pem' },
  { scopeKey: 'files_write', pattern: '**/*.key' },
  { scopeKey: 'files_write', pattern: '.env*' },
  { scopeKey: 'network_egress', pattern: '*' },
]

// ---------------------------------------------------------------------------
// Default per-persona scopes
// ---------------------------------------------------------------------------

const EMPTY_DEFAULT: PersonaDefault = {
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

export const DEFAULT_PERSONA_DEFAULTS: Record<string, PersonaDefault> = {
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
}

export const DEFAULT_CAPABILITY_POLICY: CapabilityPolicy = {
  version: 1,
  defaults: DEFAULT_PERSONA_DEFAULTS,
  modifiers: {},
  prohibitions: DEFAULT_PROHIBITIONS,
  sod_rules: DEFAULT_SOD_RULES,
}
