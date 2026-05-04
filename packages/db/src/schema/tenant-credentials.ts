/**
 * tenant-credentials.ts — Drizzle schema for tenant-scoped encrypted secrets.
 *
 * [Engineer-Principal · Opus · run-keychain-aurora]
 *
 * Replaces the /tmp file shim used in Lambda. Each row is an AES-256-GCM
 * ciphertext of one secret (Anthropic API key, GitHub token, Monday token, …),
 * scoped to a tenant. The master key lives in Secrets Manager.
 *
 * Composite PK on (tenant_id, account) enables ON CONFLICT DO UPDATE upserts.
 * No FKs (DSQL/Aurora additive-migration discipline).
 */

import { pgTable, uuid, text, customType, timestamp, primaryKey } from 'drizzle-orm/pg-core'

const bytea = customType<{ data: Buffer; default: false }>({
  dataType() {
    return 'bytea'
  },
})

export const tenantCredentials = pgTable(
  'tenant_credentials',
  {
    tenantId: uuid('tenant_id').notNull(),
    account: text('account').notNull(),
    ciphertext: bytea('ciphertext').notNull(),
    iv: bytea('iv').notNull(),
    authTag: bytea('auth_tag').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.tenantId, t.account] }),
  }),
)

export type TenantCredentialRow = typeof tenantCredentials.$inferSelect
export type TenantCredentialInsert = typeof tenantCredentials.$inferInsert
