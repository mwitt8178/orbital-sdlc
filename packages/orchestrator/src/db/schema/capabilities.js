import { pgTable, uuid, text, jsonb, boolean, timestamp, integer, index, } from 'drizzle-orm/pg-core';
/**
 * Capability layer schema — TRD-06 §4.1.
 *
 * Snake_case columns; Drizzle maps to camelCase TypeScript fields when
 * accessed via the query builder.
 *
 * Append-only constraints on every table here. The `status` column on
 * `capability_grants` is the only mutable surface and is updated only
 * through the lifecycle helpers in `capabilities/authority.ts`.
 *
 * Private key bytes are NEVER stored in Postgres. They live in the OS
 * keychain (or, in test mode, a 0600 file shim). This table holds only
 * public components and metadata.
 */
// 4.1.1 capability_grants — every issued bundle's metadata
export const capabilityGrants = pgTable('capability_grants', {
    capability_id: uuid('capability_id').primaryKey(),
    task_id: uuid('task_id').notNull(),
    session_id: uuid('session_id').notNull(),
    persona_id: text('persona_id').notNull(),
    sprint_id: uuid('sprint_id').notNull(),
    signing_sub_key_id: uuid('signing_sub_key_id').notNull(),
    scopes: jsonb('scopes').notNull(),
    parent_capability_id: uuid('parent_capability_id'),
    issued_at: timestamp('issued_at', { withTimezone: true }).notNull(),
    expires_at: timestamp('expires_at', { withTimezone: true }).notNull(),
    bundle_hash: text('bundle_hash').notNull(),
    signature: text('signature').notNull(),
    status: text('status', { enum: ['issued', 'active', 'expired', 'revoked'] }).notNull(),
    schema_version: integer('schema_version').notNull().default(1),
}, (t) => ({
    byTask: index('cg_task_idx').on(t.task_id),
    bySession: index('cg_session_idx').on(t.session_id),
    byStatus: index('cg_status_idx').on(t.status, t.expires_at),
    bySprint: index('cg_sprint_idx').on(t.sprint_id),
}));
// 4.1.2 capability_denials — every rejected tool call (audit forensics)
export const capabilityDenials = pgTable('capability_denials', {
    denial_id: uuid('denial_id').primaryKey(),
    capability_id: uuid('capability_id'),
    task_id: uuid('task_id'),
    session_id: uuid('session_id'),
    persona_id: text('persona_id'),
    attempted_tool: text('attempted_tool').notNull(),
    attempted_target: text('attempted_target').notNull(),
    reason_code: text('reason_code').notNull(),
    reason_detail: text('reason_detail').notNull(),
    prompt_excerpt: text('prompt_excerpt'),
    trace_id: text('trace_id').notNull(),
    occurred_at: timestamp('occurred_at', { withTimezone: true }).notNull(),
    /**
     * Migration 0019: soft tombstone for hygiene sweep.
     * Set to true on stale test-run denials. Preserves the audit record
     * but allows UI queries to filter them out by default.
     */
    hidden_from_ui: boolean('hidden_from_ui').notNull().default(false),
    schema_version: integer('schema_version').notNull().default(1),
}, (t) => ({
    byCap: index('cd_cap_idx').on(t.capability_id),
    byTime: index('cd_time_idx').on(t.occurred_at),
    byTool: index('cd_tool_idx').on(t.attempted_tool),
    byHidden: index('cd_hidden_idx').on(t.hidden_from_ui),
}));
// 4.1.3 capability_revocations — explicit and emergency revocations
export const capabilityRevocations = pgTable('capability_revocations', {
    revocation_id: uuid('revocation_id').primaryKey(),
    capability_id: uuid('capability_id').notNull(),
    reason: text('reason', {
        enum: [
            'task_complete',
            'task_failed',
            'task_cancelled',
            'admin_action',
            'emergency_rotation',
            'sprint_pause',
        ],
    }).notNull(),
    reason_detail: text('reason_detail'),
    revoked_by: jsonb('revoked_by').notNull(),
    revoked_at: timestamp('revoked_at', { withTimezone: true }).notNull(),
    schema_version: integer('schema_version').notNull().default(1),
}, (t) => ({ byCap: index('cr_cap_idx').on(t.capability_id) }));
// 4.1.4 signing_keys — master and sub-key METADATA. Private bytes live in keychain.
export const signingKeys = pgTable('signing_keys', {
    key_id: uuid('key_id').primaryKey(),
    key_kind: text('key_kind', { enum: ['master', 'sub'] }).notNull(),
    parent_key_id: uuid('parent_key_id'),
    install_id: uuid('install_id').notNull(),
    sprint_id: uuid('sprint_id'),
    public_key: text('public_key').notNull(),
    keychain_ref: text('keychain_ref'),
    parent_signature: text('parent_signature'),
    algorithm: text('algorithm', { enum: ['ed25519'] })
        .notNull()
        .default('ed25519'),
    created_at: timestamp('created_at', { withTimezone: true }).notNull(),
    active_from: timestamp('active_from', { withTimezone: true }).notNull(),
    active_until: timestamp('active_until', { withTimezone: true }),
    private_zeroized_at: timestamp('private_zeroized_at', { withTimezone: true }),
    status: text('status', {
        enum: ['active', 'retired', 'archived', 'compromised'],
    }).notNull(),
    schema_version: integer('schema_version').notNull().default(1),
}, (t) => ({
    byKind: index('sk_kind_idx').on(t.key_kind, t.status),
    byParent: index('sk_parent_idx').on(t.parent_key_id),
    bySprint: index('sk_sprint_idx').on(t.sprint_id),
}));
// 4.1.5 key_history — append-only audit of every key transition
export const keyHistory = pgTable('key_history', {
    history_id: uuid('history_id').primaryKey(),
    key_id: uuid('key_id').notNull(),
    transition: text('transition', {
        enum: [
            'generated',
            'signed_sub',
            'rotated',
            'retired',
            'zeroized',
            'archived',
            'compromised',
        ],
    }).notNull(),
    transition_at: timestamp('transition_at', { withTimezone: true }).notNull(),
    detail: jsonb('detail').notNull(),
    actor: jsonb('actor').notNull(),
    schema_version: integer('schema_version').notNull().default(1),
}, (t) => ({
    byKey: index('kh_key_idx').on(t.key_id),
    byTime: index('kh_time_idx').on(t.transition_at),
}));
// 4.1.6 capability_policies — runtime form of the policy TS config
export const capabilityPolicies = pgTable('capability_policies', {
    policy_id: uuid('policy_id').primaryKey(),
    version: integer('version').notNull(),
    source_hash: text('source_hash').notNull(),
    defaults: jsonb('defaults').notNull(),
    modifiers: jsonb('modifiers').notNull(),
    prohibitions: jsonb('prohibitions').notNull(),
    sod_rules: jsonb('sod_rules').notNull(),
    activated_at: timestamp('activated_at', { withTimezone: true }).notNull(),
    deactivated_at: timestamp('deactivated_at', { withTimezone: true }),
    activated_by: jsonb('activated_by').notNull(),
    schema_version: integer('schema_version').notNull().default(1),
}, (t) => ({ byVersion: index('cp_ver_idx').on(t.version) }));
//# sourceMappingURL=capabilities.js.map