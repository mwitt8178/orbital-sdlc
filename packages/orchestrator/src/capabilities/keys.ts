/**
 * KeyManager — two-tier Ed25519 key hierarchy.
 *
 * Per TRD-06 §11.1 and SAO §5.4:
 * - Master key (KEK): Ed25519 keypair generated at orbital init.
 * - Sub-keys (DEKs): Ed25519 keypair per sprint at sprint-start. Master signs
 *   `H(sub_pub_key || sub.created_at || install_id || sprint_id)` to bind the
 *   sub-key into the chain.
 * - Private bytes live in the OS keychain. Public bytes live in `signing_keys`.
 * - Sub-key private retention: 30 days after sprint close, then zeroized.
 *
 * Real cryptography only — `@noble/ed25519` v2 with SHA-512 wired in.
 */

import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { uuidv7 } from 'uuidv7'
import { eq, and, isNull, desc } from 'drizzle-orm'
import { db } from '../db/client.js'
import {
  signingKeys,
  keyHistory,
  type SigningKeyRow,
} from '../db/schema/capabilities.js'
import { logger } from '../config/logger.js'
import { getKeychain } from './keychain.js'
import { OrbitalError, type EventInput, type Actor } from '@orbital/types'
import type { EventStore } from '../events/store.js'

// Wire SHA-512 once at module load. Per @noble/ed25519 v2: sha512Sync (and
// sha512Async for async paths) live on `etc` and must be set before any sign
// or verify call.
ed.etc.sha512Sync = (...messages: Uint8Array[]) =>
  sha512(messages.length === 1 ? (messages[0] as Uint8Array) : ed.etc.concatBytes(...messages))
ed.etc.sha512Async = async (...messages: Uint8Array[]) =>
  sha512(messages.length === 1 ? (messages[0] as Uint8Array) : ed.etc.concatBytes(...messages))

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface MasterKey {
  keyId: string
  publicKey: Uint8Array
  installId: string
  createdAt: string
  status: 'active' | 'retired' | 'archived' | 'compromised'
}

export interface SubKey {
  keyId: string
  parentKeyId: string
  publicKey: Uint8Array
  installId: string
  sprintId: string
  parentSignature: string // base64
  createdAt: string
  activeFrom: string
  activeUntil: string | null
  status: 'active' | 'retired' | 'archived' | 'compromised'
}

export interface SignedMessage {
  signature: string // base64
  signingKeyId: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function bytesToBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64')
}

function base64ToBytes(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64'))
}

function masterAccount(keyId: string): string {
  return `master:${keyId}`
}

function subAccount(keyId: string): string {
  return `sub:${keyId}`
}

/** The bytes the master signs to bind a sub-key into the chain. */
function subKeyChainMessage(
  subPublicKey: Uint8Array,
  createdAt: string,
  installId: string,
  sprintId: string,
): Uint8Array {
  const tag = `orbital-subkey-binding-v1:${installId}:${sprintId}:${createdAt}:`
  const tagBytes = new TextEncoder().encode(tag)
  const combined = new Uint8Array(tagBytes.length + subPublicKey.length)
  combined.set(tagBytes, 0)
  combined.set(subPublicKey, tagBytes.length)
  return combined
}

// ---------------------------------------------------------------------------
// KeyManager
// ---------------------------------------------------------------------------

export class KeyManager {
  constructor(
    private readonly installId: string,
    private readonly eventStore: EventStore,
  ) {}

  // -------------------------------------------------------------------------
  // Master keys
  // -------------------------------------------------------------------------

  /**
   * Generate a new master keypair, persist private to keychain, public + metadata
   * to signing_keys, and record in key_history. No event is emitted for the
   * initial bootstrap; rotation events emit KeyRotated.
   */
  async generateMaster(actor: Actor): Promise<MasterKey> {
    const privateKey = ed.utils.randomPrivateKey()
    const publicKey = await ed.getPublicKeyAsync(privateKey)

    const keyId = uuidv7()
    const now = new Date().toISOString()

    // Store private bytes in keychain (base64).
    const keychain = await getKeychain()
    const account = masterAccount(keyId)
    await keychain.setPassword(account, bytesToBase64(privateKey))

    // Persist row.
    await db.insert(signingKeys).values({
      key_id: keyId,
      key_kind: 'master',
      parent_key_id: null,
      install_id: this.installId,
      sprint_id: null,
      public_key: bytesToBase64(publicKey),
      keychain_ref: account,
      parent_signature: null,
      algorithm: 'ed25519',
      created_at: new Date(now),
      active_from: new Date(now),
      active_until: null,
      private_zeroized_at: null,
      status: 'active',
      schema_version: 1,
    })

    await this.recordHistory(keyId, 'generated', { kind: 'master' }, actor)

    logger.info({ keyId, installId: this.installId }, 'KeyManager: master key generated')

    return {
      keyId,
      publicKey,
      installId: this.installId,
      createdAt: now,
      status: 'active',
    }
  }

  /** Get the active master key. Returns null if none. */
  async getActiveMaster(): Promise<MasterKey | null> {
    const rows = await db
      .select()
      .from(signingKeys)
      .where(
        and(
          eq(signingKeys.key_kind, 'master'),
          eq(signingKeys.install_id, this.installId),
          eq(signingKeys.status, 'active'),
          isNull(signingKeys.active_until),
        ),
      )
      .orderBy(desc(signingKeys.active_from))
      .limit(1)

    const row = rows[0]
    return row ? rowToMaster(row) : null
  }

  /** Get or create the active master key. */
  async getOrCreateActiveMaster(actor: Actor): Promise<MasterKey> {
    const existing = await this.getActiveMaster()
    if (existing) return existing
    return this.generateMaster(actor)
  }

  // -------------------------------------------------------------------------
  // Sub-keys
  // -------------------------------------------------------------------------

  /**
   * Generate a new sprint sub-key. Master signs the sub-key public component
   * to bind it into the chain. Records key_history `signed_sub` transition.
   */
  async generateSubKey(sprintId: string, actor: Actor): Promise<SubKey> {
    const master = await this.getOrCreateActiveMaster(actor)

    const privateKey = ed.utils.randomPrivateKey()
    const publicKey = await ed.getPublicKeyAsync(privateKey)
    const keyId = uuidv7()
    const now = new Date().toISOString()

    // Master signs the chain message.
    const masterPriv = await this.loadMasterPrivate(master.keyId)
    const chainMsg = subKeyChainMessage(publicKey, now, this.installId, sprintId)
    const parentSig = await ed.signAsync(chainMsg, masterPriv)
    const parentSigB64 = bytesToBase64(parentSig)
    masterPriv.fill(0) // best-effort zeroize

    // Store sub-key private in keychain.
    const keychain = await getKeychain()
    const account = subAccount(keyId)
    await keychain.setPassword(account, bytesToBase64(privateKey))

    // Persist row.
    await db.insert(signingKeys).values({
      key_id: keyId,
      key_kind: 'sub',
      parent_key_id: master.keyId,
      install_id: this.installId,
      sprint_id: sprintId,
      public_key: bytesToBase64(publicKey),
      keychain_ref: account,
      parent_signature: parentSigB64,
      algorithm: 'ed25519',
      created_at: new Date(now),
      active_from: new Date(now),
      active_until: null,
      private_zeroized_at: null,
      status: 'active',
      schema_version: 1,
    })

    await this.recordHistory(
      keyId,
      'signed_sub',
      { parent_key_id: master.keyId, sprint_id: sprintId },
      actor,
    )

    logger.info({ keyId, parentKeyId: master.keyId, sprintId }, 'KeyManager: sub-key generated')

    return {
      keyId,
      parentKeyId: master.keyId,
      publicKey,
      installId: this.installId,
      sprintId,
      parentSignature: parentSigB64,
      createdAt: now,
      activeFrom: now,
      activeUntil: null,
      status: 'active',
    }
  }

  /** Get the active sub-key for the sprint, or null if none. */
  async getActiveSubKey(sprintId: string): Promise<SubKey | null> {
    const rows = await db
      .select()
      .from(signingKeys)
      .where(
        and(
          eq(signingKeys.key_kind, 'sub'),
          eq(signingKeys.install_id, this.installId),
          eq(signingKeys.sprint_id, sprintId),
          eq(signingKeys.status, 'active'),
          isNull(signingKeys.active_until),
        ),
      )
      .orderBy(desc(signingKeys.active_from))
      .limit(1)

    const row = rows[0]
    return row ? rowToSub(row) : null
  }

  /** Get or generate the active sub-key for the sprint. */
  async getOrCreateActiveSubKey(sprintId: string, actor: Actor): Promise<SubKey> {
    const existing = await this.getActiveSubKey(sprintId)
    if (existing) return existing
    return this.generateSubKey(sprintId, actor)
  }

  /** Lookup any sub-key by id, including retired/archived for historical verify. */
  async getSubKeyById(keyId: string): Promise<SubKey | null> {
    const rows = await db
      .select()
      .from(signingKeys)
      .where(and(eq(signingKeys.key_id, keyId), eq(signingKeys.key_kind, 'sub')))
      .limit(1)
    const row = rows[0]
    return row ? rowToSub(row) : null
  }

  /** Lookup any master by id. */
  async getMasterById(keyId: string): Promise<MasterKey | null> {
    const rows = await db
      .select()
      .from(signingKeys)
      .where(and(eq(signingKeys.key_id, keyId), eq(signingKeys.key_kind, 'master')))
      .limit(1)
    const row = rows[0]
    return row ? rowToMaster(row) : null
  }

  // -------------------------------------------------------------------------
  // Signing using a sub-key
  // -------------------------------------------------------------------------

  /** Sign arbitrary message bytes with the named sub-key's private. */
  async signWithSubKey(keyId: string, message: Uint8Array): Promise<SignedMessage> {
    const priv = await this.loadSubPrivate(keyId)
    const sig = await ed.signAsync(message, priv)
    priv.fill(0)
    return { signature: bytesToBase64(sig), signingKeyId: keyId }
  }

  /** Verify a signature against a sub-key's public component. */
  async verifyWithSubKey(
    keyId: string,
    message: Uint8Array,
    signatureB64: string,
  ): Promise<boolean> {
    const sub = await this.getSubKeyById(keyId)
    if (!sub) return false
    if (sub.status === 'compromised') return false
    return ed.verifyAsync(base64ToBytes(signatureB64), message, sub.publicKey)
  }

  /**
   * Verify the chain: a sub-key is valid for a given timestamp if it was
   * signed by a master that was active at that time and the sub-key itself
   * was active.
   */
  async verifySubKeyChain(keyId: string, atTime: string): Promise<boolean> {
    const sub = await this.getSubKeyById(keyId)
    if (!sub) return false
    if (sub.status === 'compromised') return false
    const at = new Date(atTime).getTime()
    if (at < new Date(sub.activeFrom).getTime()) return false
    if (sub.activeUntil && at > new Date(sub.activeUntil).getTime()) return false

    const master = await this.getMasterById(sub.parentKeyId)
    if (!master) return false
    if (master.status === 'compromised') return false

    // Re-verify the master's signature on the sub-key (defense in depth).
    const chainMsg = subKeyChainMessage(
      sub.publicKey,
      sub.createdAt,
      this.installId,
      sub.sprintId,
    )
    const ok = await ed.verifyAsync(
      base64ToBytes(sub.parentSignature),
      chainMsg,
      master.publicKey,
    )
    return ok
  }

  // -------------------------------------------------------------------------
  // Rotation and archival
  // -------------------------------------------------------------------------

  /**
   * Rotate: generate a new sub-key for the sprint, retire the old, emit
   * `KeyRotated` event. Old key's public component remains for historical
   * verification; private retained for the 30-day retention window.
   */
  async rotate(sprintId: string, actor: Actor): Promise<{ retiredKeyId: string; newKeyId: string }> {
    const old = await this.getActiveSubKey(sprintId)
    if (!old) {
      // Nothing to rotate; just generate.
      const next = await this.generateSubKey(sprintId, actor)
      await this.emitKeyRotated('sub_on_demand', null, next.keyId, 0, actor)
      return { retiredKeyId: '', newKeyId: next.keyId }
    }

    // Retire the old: set active_until=now, status='retired'.
    const now = new Date()
    await db
      .update(signingKeys)
      .set({ active_until: now, status: 'retired' })
      .where(eq(signingKeys.key_id, old.keyId))

    await this.recordHistory(old.keyId, 'retired', { reason: 'rotation' }, actor)

    const next = await this.generateSubKey(sprintId, actor)

    await this.emitKeyRotated('sub_on_demand', old.keyId, next.keyId, 0, actor)

    logger.info({ retired: old.keyId, next: next.keyId, sprintId }, 'KeyManager: sub-key rotated')

    return { retiredKeyId: old.keyId, newKeyId: next.keyId }
  }

  /**
   * Archive: zeroize private component, emit `KeyArchived` event, leave public
   * component for historical verification. Idempotent — re-archiving a key
   * already archived is a no-op.
   */
  async archive(keyId: string, retentionBasis: 'sprint_close_30d' | 'master_rotation' | 'compromise', actor: Actor): Promise<void> {
    const rows = await db.select().from(signingKeys).where(eq(signingKeys.key_id, keyId)).limit(1)
    const row = rows[0]
    if (!row) {
      throw new OrbitalError('NOT_FOUND_SIGNING_KEY', `signing key ${keyId} not found`)
    }
    if (row.status === 'archived' && row.private_zeroized_at) {
      // Idempotent.
      return
    }

    // Delete from keychain (zeroize on-disk private bytes). Best-effort.
    if (row.keychain_ref) {
      const keychain = await getKeychain()
      try {
        await keychain.deletePassword(row.keychain_ref)
      } catch (err) {
        logger.warn({ err, keyId }, 'KeyManager: keychain delete failed during archive')
      }
    }

    const now = new Date()
    await db
      .update(signingKeys)
      .set({ status: 'archived', private_zeroized_at: now, keychain_ref: null })
      .where(eq(signingKeys.key_id, keyId))

    await this.recordHistory(keyId, 'archived', { retention_basis: retentionBasis }, actor)
    await this.recordHistory(keyId, 'zeroized', { retention_basis: retentionBasis }, actor)

    // Emit KeyArchived event.
    const ev: EventInput = {
      aggregate_id: keyId,
      aggregate_type: 'system',
      event_type: 'KeyArchived',
      payload: {
        key_id: keyId,
        zeroized_at: now.toISOString(),
        retention_basis: retentionBasis,
      },
      actor,
      trace_id: 'system',
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)

    logger.info({ keyId, retentionBasis }, 'KeyManager: key archived (private zeroized)')
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private async loadMasterPrivate(keyId: string): Promise<Uint8Array> {
    const rows = await db
      .select()
      .from(signingKeys)
      .where(and(eq(signingKeys.key_id, keyId), eq(signingKeys.key_kind, 'master')))
      .limit(1)
    const row = rows[0]
    if (!row || !row.keychain_ref) {
      throw new OrbitalError(
        'INTERNAL_KEYCHAIN_ERROR',
        `master private key not retrievable for ${keyId}`,
      )
    }
    const keychain = await getKeychain()
    const b64 = await keychain.getPassword(row.keychain_ref)
    if (!b64) {
      throw new OrbitalError('INTERNAL_KEYCHAIN_ERROR', `keychain entry missing for ${keyId}`)
    }
    return base64ToBytes(b64)
  }

  private async loadSubPrivate(keyId: string): Promise<Uint8Array> {
    const rows = await db
      .select()
      .from(signingKeys)
      .where(and(eq(signingKeys.key_id, keyId), eq(signingKeys.key_kind, 'sub')))
      .limit(1)
    const row = rows[0]
    if (!row || !row.keychain_ref) {
      throw new OrbitalError(
        'INTERNAL_KEYCHAIN_ERROR',
        `sub private key not retrievable for ${keyId}`,
      )
    }
    const keychain = await getKeychain()
    const b64 = await keychain.getPassword(row.keychain_ref)
    if (!b64) {
      throw new OrbitalError('INTERNAL_KEYCHAIN_ERROR', `keychain entry missing for ${keyId}`)
    }
    return base64ToBytes(b64)
  }

  private async recordHistory(
    keyId: string,
    transition:
      | 'generated'
      | 'signed_sub'
      | 'rotated'
      | 'retired'
      | 'zeroized'
      | 'archived'
      | 'compromised',
    detail: Record<string, unknown>,
    actor: Actor,
  ): Promise<void> {
    await db.insert(keyHistory).values({
      history_id: uuidv7(),
      key_id: keyId,
      transition,
      transition_at: new Date(),
      detail,
      actor,
      schema_version: 1,
    })
  }

  private async emitKeyRotated(
    rotationKind:
      | 'master_scheduled'
      | 'master_on_demand'
      | 'sub_sprint_close'
      | 'sub_on_demand'
      | 'major_upgrade',
    retiredKeyId: string | null,
    newKeyId: string,
    cascadeCount: number,
    actor: Actor,
  ): Promise<void> {
    const ev: EventInput = {
      aggregate_id: newKeyId,
      aggregate_type: 'system',
      event_type: 'KeyRotated',
      payload: {
        rotation_kind: rotationKind,
        retired_key_id: retiredKeyId,
        new_key_id: newKeyId,
        cascade_count: cascadeCount,
      },
      actor,
      trace_id: 'system',
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

function rowToMaster(row: SigningKeyRow): MasterKey {
  return {
    keyId: row.key_id,
    publicKey: base64ToBytes(row.public_key),
    installId: row.install_id,
    createdAt: row.created_at.toISOString(),
    status: row.status,
  }
}

function rowToSub(row: SigningKeyRow): SubKey {
  if (!row.parent_key_id || !row.sprint_id || !row.parent_signature) {
    throw new Error(`malformed sub-key row: ${row.key_id}`)
  }
  return {
    keyId: row.key_id,
    parentKeyId: row.parent_key_id,
    publicKey: base64ToBytes(row.public_key),
    installId: row.install_id,
    sprintId: row.sprint_id,
    parentSignature: row.parent_signature,
    createdAt: row.created_at.toISOString(),
    activeFrom: row.active_from.toISOString(),
    activeUntil: row.active_until ? row.active_until.toISOString() : null,
    status: row.status,
  }
}

// ---------------------------------------------------------------------------
// Public re-exports for tests
// ---------------------------------------------------------------------------

export { subKeyChainMessage }
