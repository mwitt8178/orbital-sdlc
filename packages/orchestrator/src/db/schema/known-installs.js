/**
 * known-installs.ts — Drizzle schema for hub-side install registry.
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Each row represents one laptop (install) paired with the hub. The hub uses
 * `public_key` to verify Ed25519 signatures on every inbound request from
 * that install. `revoked_at IS NOT NULL` is the kill switch.
 *
 * Per multi-tenant-isolation: every row carries `tenant_id`. Hub registration
 * stamps the tenant from the invite JWT.
 *
 * Per multi-tenant-migrations: this table is additive. No FKs, no triggers,
 * no sequences. UUIDv7 install_id from the application layer.
 *
 * Per DSQL constraints: no foreign keys to other tables (install_id is opaque
 * to other aggregates). Indexes added directly in the migration; no sequences.
 *
 * `invite_jti` enforces single-use invite tokens via a UNIQUE INDEX. The first
 * registration consumes the jti; subsequent attempts to reuse the same invite
 * fail with a unique-constraint violation that the registration handler maps
 * to AUTH_INVITE_ALREADY_USED.
 */
import { pgTable, uuid, text, timestamp, index, uniqueIndex } from 'drizzle-orm/pg-core';
export const knownInstalls = pgTable('known_installs', {
    install_id: uuid('install_id').primaryKey(),
    tenant_id: uuid('tenant_id')
        .notNull()
        .default('00000000-0000-0000-0000-000000000000'),
    public_key: text('public_key').notNull(),
    role: text('role', { enum: ['owner', 'member', 'viewer'] }).notNull(),
    display_name: text('display_name'),
    invite_jti: text('invite_jti').notNull(),
    joined_at: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    last_seen_at: timestamp('last_seen_at', { withTimezone: true }),
    revoked_at: timestamp('revoked_at', { withTimezone: true }),
}, (t) => ({
    inviteJtiUniq: uniqueIndex('known_installs_invite_jti_uniq').on(t.invite_jti),
    tenantIdx: index('known_installs_tenant_idx').on(t.tenant_id, t.revoked_at),
}));
//# sourceMappingURL=known-installs.js.map