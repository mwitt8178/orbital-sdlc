/**
 * recovery/verify.ts — capability attestation chain verification.
 *
 * Moved from cli/verify.ts. Walks the four-level attestation chain per SAO §5.9:
 *   commit_hash → capability → sub-key → master → install_id
 *
 * Used by the admin.verify.attestation tRPC procedure.
 */

import { eq, and, sql as dSQL } from 'drizzle-orm'
import { db, sql, closeDb } from '../db/client.js'
import { capabilityGrants, capabilityRevocations, signingKeys } from '../db/schema/capabilities.js'
import { events } from '../db/schema/events.js'
import { createEventStore } from '../events/store.js'
import { KeyManager } from '../capabilities/keys.js'
import { getInstallId } from '../config/install.js'

export interface VerifyOptions {
  /** When true, do not call closeDb() — used by integration tests. */
  keepDbOpen?: boolean
  /** Output format. Default: 'json'. */
  format?: 'json' | 'text'
}

export interface VerifyChainResult {
  ok: boolean
  code: string
  message: string
  commitNotAttested?: boolean
  details?: {
    capability_id: string
    persona_id: string
    task_id: string
    sprint_id: string
    sub_key_id: string
    master_key_id: string
    install_id: string
    issued_at: string
    expires_at: string
  }
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/

async function resolveCapabilityId(input: string): Promise<string | null> {
  if (UUID_RE.test(input)) {
    const rows = await db
      .select({ id: capabilityGrants.capability_id })
      .from(capabilityGrants)
      .where(eq(capabilityGrants.capability_id, input))
      .limit(1)
    if (rows.length > 0) return input
  }

  const rows = await db
    .select({
      capability_id: events.capabilityId,
      payload: events.payload,
    })
    .from(events)
    .where(
      and(
        eq(events.eventType, 'CommitSigned'),
        dSQL`${events.payload}->>'commit_hash' = ${input}`,
      ),
    )
    .limit(1)

  const row = rows[0]
  if (!row) return null
  return row.capability_id ?? null
}

export async function runVerify(
  input: string,
  options: VerifyOptions = {},
): Promise<VerifyChainResult> {
  if (!input || input.trim().length === 0) {
    return {
      ok: false,
      code: 'INVALID_INPUT',
      message: 'pass a capability_id (UUID) or commit hash',
    }
  }

  const trimmed = input.trim()
  const looksLikeCommitHash = !UUID_RE.test(trimmed) && /^[0-9a-fA-F]{7,64}$/.test(trimmed)

  const capabilityId = await resolveCapabilityId(trimmed)
  if (!capabilityId) {
    if (!options.keepDbOpen) await closeDb().catch(() => undefined)

    if (looksLikeCommitHash) {
      return {
        ok: false,
        code: 'COMMIT_NOT_ATTESTED',
        message:
          `No CommitSigned event found for commit "${trimmed}". ` +
          'Commit-signing (git.sign_commit MCP tool) is not yet wired in this build. ' +
          'Verify the issuing capability directly by passing the capability_id (UUID) instead.',
        commitNotAttested: true,
      }
    }

    return {
      ok: false,
      code: 'NOT_FOUND',
      message: `no capability or CommitSigned event found for input "${trimmed}"`,
    }
  }

  const grantRows = await db
    .select()
    .from(capabilityGrants)
    .where(eq(capabilityGrants.capability_id, capabilityId))
    .limit(1)
  const grant = grantRows[0]
  if (!grant) {
    if (!options.keepDbOpen) await closeDb().catch(() => undefined)
    return {
      ok: false,
      code: 'CAPABILITY_NOT_FOUND',
      message: `capability_grants row missing for ${capabilityId}`,
    }
  }

  const rev = await db
    .select({ id: capabilityRevocations.revocation_id })
    .from(capabilityRevocations)
    .where(eq(capabilityRevocations.capability_id, capabilityId))
    .limit(1)
  if (rev.length > 0) {
    if (!options.keepDbOpen) await closeDb().catch(() => undefined)
    return {
      ok: false,
      code: 'AUTH_CAPABILITY_REVOKED',
      message: `capability ${capabilityId} has been revoked`,
    }
  }

  const subRows = await db
    .select()
    .from(signingKeys)
    .where(and(eq(signingKeys.key_id, grant.signing_sub_key_id), eq(signingKeys.key_kind, 'sub')))
    .limit(1)
  const sub = subRows[0]
  if (!sub) {
    if (!options.keepDbOpen) await closeDb().catch(() => undefined)
    return {
      ok: false,
      code: 'AUTH_UNKNOWN_SIGNING_KEY',
      message: `sub-key ${grant.signing_sub_key_id} not found`,
    }
  }
  if (sub.status === 'compromised') {
    if (!options.keepDbOpen) await closeDb().catch(() => undefined)
    return {
      ok: false,
      code: 'AUTH_KEY_COMPROMISED',
      message: `sub-key ${sub.key_id} marked compromised`,
    }
  }

  if (!sub.parent_key_id) {
    if (!options.keepDbOpen) await closeDb().catch(() => undefined)
    return {
      ok: false,
      code: 'MALFORMED_SUB_KEY',
      message: `sub-key ${sub.key_id} has no parent_key_id`,
    }
  }
  const masterRows = await db
    .select()
    .from(signingKeys)
    .where(and(eq(signingKeys.key_id, sub.parent_key_id), eq(signingKeys.key_kind, 'master')))
    .limit(1)
  const master = masterRows[0]
  if (!master) {
    if (!options.keepDbOpen) await closeDb().catch(() => undefined)
    return {
      ok: false,
      code: 'AUTH_UNKNOWN_MASTER_KEY',
      message: `master key ${sub.parent_key_id} not found`,
    }
  }
  if (master.status === 'compromised') {
    if (!options.keepDbOpen) await closeDb().catch(() => undefined)
    return {
      ok: false,
      code: 'AUTH_MASTER_COMPROMISED',
      message: `master key ${master.key_id} marked compromised`,
    }
  }

  const installId = await getInstallId()
  if (master.install_id !== installId) {
    if (!options.keepDbOpen) await closeDb().catch(() => undefined)
    return {
      ok: false,
      code: 'INSTALL_ID_MISMATCH',
      message: `master.install_id=${master.install_id} does not match local install_id=${installId}`,
    }
  }

  const eventStore = createEventStore(db, sql)
  const km = new KeyManager(installId, eventStore)
  const chainOk = await km.verifySubKeyChain(sub.key_id, grant.issued_at.toISOString())
  if (!chainOk) {
    if (!options.keepDbOpen) await closeDb().catch(() => undefined)
    return {
      ok: false,
      code: 'AUTH_INVALID_KEY_CHAIN',
      message: `cryptographic chain verify failed for sub-key ${sub.key_id} at ${grant.issued_at.toISOString()}`,
    }
  }

  if (!options.keepDbOpen) await closeDb().catch(() => undefined)
  return {
    ok: true,
    code: 'VERIFIED',
    message: 'attestation chain verifies end-to-end',
    details: {
      capability_id: grant.capability_id,
      persona_id: grant.persona_id,
      task_id: grant.task_id,
      sprint_id: grant.sprint_id,
      sub_key_id: sub.key_id,
      master_key_id: master.key_id,
      install_id: master.install_id,
      issued_at: grant.issued_at.toISOString(),
      expires_at: grant.expires_at.toISOString(),
    },
  }
}
