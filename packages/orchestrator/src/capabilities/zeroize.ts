/**
 * zeroize.ts — KeyZeroizeService.
 *
 * Per TRD-06 v0.2 §4.3 + SAO §5.4 line 235:
 * "Sub-keys retain their private component for 30 days after sprint close to
 * allow late-arriving operations … After 30 days, private component is zeroized;
 * only the public component survives for verification."
 *
 * And TRD-06 §14 (CC6.7):
 * "Sub-key zeroization at +30 days: assert keychain item gone,
 * private_zeroized_at populated, KeyArchived event present, public component
 * still in signing_keys for verification."
 *
 * This service queries `signing_keys` for rows that:
 *   - have `active_until < now() - olderThanDays` (the key was retired/archived)
 *   - have `private_zeroized_at IS NULL` (not yet zeroized)
 *   - have `keychain_ref IS NOT NULL` (private bytes still in keychain)
 *   - have `status IN ('retired', 'archived')` (never zeroize active/compromised)
 *
 * For each such row:
 *   1. Deletes the keychain entry (zeroizes private bytes on disk/keychain).
 *   2. Sets `private_zeroized_at = now()`, `keychain_ref = NULL`, `status = 'archived'`.
 *   3. Emits `KeyArchived` event with `reason: 'retention_window_elapsed'`.
 *
 * Idempotent: rows already having `private_zeroized_at` set are skipped by the query.
 */

import { uuidv7 } from 'uuidv7'
import { and, eq, isNull, isNotNull, lt, inArray } from 'drizzle-orm'
import { db as defaultDb } from '../db/client.js'
import { signingKeys } from '../db/schema/capabilities.js'
import { getKeychain } from './keychain.js'
import { logger } from '../config/logger.js'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import type { EventInput, Actor } from '../events/types.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ZeroizeResult {
  /** Number of keys whose private bytes were successfully zeroized. */
  zeroizedCount: number
  /** Key IDs that were zeroized. */
  zeroizedKeyIds: string[]
  /** Errors encountered (non-fatal: other keys are still processed). */
  errors: Array<{ keyId: string; error: string }>
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }
const MS_PER_DAY = 24 * 60 * 60 * 1000

// ---------------------------------------------------------------------------
// KeyZeroizeService
// ---------------------------------------------------------------------------

export class KeyZeroizeService {
  constructor(
    private readonly eventStore: EventStore,
    private readonly database: DB = defaultDb,
  ) {}

  /**
   * Find all signing_keys where:
   *   - active_until < now() - olderThanDays
   *   - private_zeroized_at IS NULL
   *   - keychain_ref IS NOT NULL
   *   - status IN ('retired', 'archived')
   *
   * For each: delete keychain entry, set private_zeroized_at + keychain_ref=NULL
   * + status='archived', emit KeyArchived event.
   *
   * Returns a result summary. Errors per-key are non-fatal.
   */
  async zeroizeOldKeys(olderThanDays = 30): Promise<ZeroizeResult> {
    const cutoff = new Date(Date.now() - olderThanDays * MS_PER_DAY)

    // Find candidate rows.
    const candidates = await this.database
      .select({
        key_id: signingKeys.key_id,
        keychain_ref: signingKeys.keychain_ref,
        status: signingKeys.status,
      })
      .from(signingKeys)
      .where(
        and(
          // active_until < cutoff — the key was retired at least 30 days ago
          lt(signingKeys.active_until, cutoff),
          // private bytes not yet zeroized
          isNull(signingKeys.private_zeroized_at),
          // keychain entry must exist
          isNotNull(signingKeys.keychain_ref),
          // only retired/archived keys — never touch active or compromised
          inArray(signingKeys.status, ['retired', 'archived']),
        ),
      )

    const result: ZeroizeResult = {
      zeroizedCount: 0,
      zeroizedKeyIds: [],
      errors: [],
    }

    if (candidates.length === 0) {
      logger.debug({ olderThanDays, cutoff }, 'KeyZeroizeService.zeroizeOldKeys: no candidates')
      return result
    }

    logger.info(
      { count: candidates.length, olderThanDays, cutoff },
      'KeyZeroizeService.zeroizeOldKeys: processing candidates',
    )

    const keychain = await getKeychain()
    const now = new Date()

    for (const row of candidates) {
      const { key_id: keyId, keychain_ref: keychainRef } = row
      if (!keychainRef) continue // guard; already filtered by IS NOT NULL

      try {
        // Step 1: delete from keychain (zeroize private bytes).
        try {
          await keychain.deletePassword(keychainRef)
          logger.debug({ keyId, keychainRef }, 'KeyZeroizeService: keychain entry deleted')
        } catch (keychainErr) {
          // If the entry is already missing that is fine — the goal is achieved.
          logger.warn(
            { keychainErr, keyId, keychainRef },
            'KeyZeroizeService: keychain delete warning (may already be absent)',
          )
        }

        // Step 2: mark DB row as archived with private_zeroized_at.
        await this.database
          .update(signingKeys)
          .set({
            status: 'archived',
            private_zeroized_at: now,
            keychain_ref: null,
          })
          .where(
            and(
              eq(signingKeys.key_id, keyId),
              // Idempotency guard: only update if still not zeroized.
              isNull(signingKeys.private_zeroized_at),
            ),
          )

        // Step 3: emit KeyArchived event.
        const ev: EventInput = {
          aggregate_id: keyId,
          aggregate_type: 'system',
          event_type: 'KeyArchived',
          payload: {
            key_id: keyId,
            zeroized_at: now.toISOString(),
            reason: 'retention_window_elapsed',
          },
          actor: SYSTEM_ACTOR,
          trace_id: uuidv7(),
          occurred_at: now.toISOString(),
          schema_version: 1,
        }
        await this.eventStore.append(ev)

        result.zeroizedKeyIds.push(keyId)
        result.zeroizedCount++

        logger.info(
          { keyId, keychainRef, olderThanDays },
          'KeyZeroizeService: private key zeroized (retention window elapsed)',
        )
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        result.errors.push({ keyId, error: message })
        logger.error(
          { err, keyId },
          'KeyZeroizeService.zeroizeOldKeys: error zeroizing key (non-fatal; other keys continue)',
        )
      }
    }

    return result
  }
}
