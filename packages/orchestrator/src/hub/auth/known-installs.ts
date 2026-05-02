/**
 * hub/auth/known-installs.ts — Query helpers for the known_installs table.
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Hub-side. Local installs never read this table (they only know about
 * themselves — their install_id and privkey live on disk, see
 * keys/install-key.ts).
 *
 * All reads/writes go through this module so we have one place to log
 * `last_seen_at` updates and one place to guard `revoked_at IS NOT NULL`.
 */

import { eq } from 'drizzle-orm'
import { db, sql } from '../../db/client.js'
import { knownInstalls, type KnownInstallRow } from '../../db/schema/known-installs.js'

export interface InstallIdentity {
  installId: string
  tenantId: string
  publicKey: string // base64url
  role: 'owner' | 'member' | 'viewer'
  displayName: string | null
  joinedAt: string
  lastSeenAt: string | null
  revokedAt: string | null
}

function rowToIdentity(row: KnownInstallRow): InstallIdentity {
  return {
    installId: row.install_id,
    tenantId: row.tenant_id,
    publicKey: row.public_key,
    role: row.role as 'owner' | 'member' | 'viewer',
    displayName: row.display_name,
    joinedAt: row.joined_at.toISOString(),
    lastSeenAt: row.last_seen_at ? row.last_seen_at.toISOString() : null,
    revokedAt: row.revoked_at ? row.revoked_at.toISOString() : null,
  }
}

/**
 * Fetch a single install by id. Returns null if no row exists.
 */
export async function getInstallById(installId: string): Promise<InstallIdentity | null> {
  const rows = await db
    .select()
    .from(knownInstalls)
    .where(eq(knownInstalls.install_id, installId))
    .limit(1)
  const row = rows[0]
  return row ? rowToIdentity(row) : null
}

/**
 * Insert a new install row. Throws on PK conflict (caller handles re-register
 * vs. duplicate-jti). The caller MUST have already validated the invite token
 * — this function does no token verification.
 */
export async function registerInstall(opts: {
  installId: string
  tenantId: string
  publicKey: string
  role: 'owner' | 'member' | 'viewer'
  displayName: string | null
  inviteJti: string
}): Promise<InstallIdentity> {
  const inserted = await db
    .insert(knownInstalls)
    .values({
      install_id: opts.installId,
      tenant_id: opts.tenantId,
      public_key: opts.publicKey,
      role: opts.role,
      display_name: opts.displayName,
      invite_jti: opts.inviteJti,
      joined_at: new Date(),
      last_seen_at: null,
      revoked_at: null,
    })
    .returning()

  const row = inserted[0]
  if (!row) {
    throw new Error('registerInstall: insert returned no row')
  }
  return rowToIdentity(row)
}

/**
 * Mark an install revoked. Idempotent — re-revoking is a no-op.
 */
export async function revokeInstall(installId: string): Promise<void> {
  await sql`
    UPDATE known_installs
    SET revoked_at = NOW()
    WHERE install_id = ${installId}
      AND revoked_at IS NULL
  `
}

/**
 * Update last_seen_at to now. Best-effort; failure is logged by callers but
 * never blocks the request.
 */
export async function touchLastSeen(installId: string): Promise<void> {
  await sql`
    UPDATE known_installs
    SET last_seen_at = NOW()
    WHERE install_id = ${installId}
  `
}

/**
 * List all installs. Used by hub-admin to render the members table.
 */
export async function listInstalls(): Promise<InstallIdentity[]> {
  const rows = await db
    .select()
    .from(knownInstalls)
    .orderBy(knownInstalls.joined_at)
  return rows.map(rowToIdentity)
}
