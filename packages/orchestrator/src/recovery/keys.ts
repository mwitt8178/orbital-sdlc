/**
 * recovery/keys.ts — signing key rotation.
 *
 * Moved from cli/keys.ts. Rotates the active sub-key for a sprint via
 * KeyManager.rotate(). Used by the admin.keys.rotate tRPC procedure.
 */

import { eq, desc, and, isNull } from 'drizzle-orm'
import { db, sql, closeDb } from '../db/client.js'
import { signingKeys, keyHistory } from '../db/schema/capabilities.js'
import { events } from '../db/schema/events.js'
import { createEventStore } from '../events/store.js'
import { KeyManager } from '../capabilities/keys.js'
import { getInstallId } from '../config/install.js'
import { info, warn, exitWithError } from './io.js'
import type { Actor } from '@orbital/types'

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

export interface KeysRotateOptions {
  sprintId?: string
  /** When true, do not call closeDb() — used by integration tests. */
  keepDbOpen?: boolean
}

export interface KeysRotateResult {
  retiredKeyId: string
  newKeyId: string
  rotatedEventId: string
  sprintId: string
}

async function findLatestActiveSprint(installId: string): Promise<string | null> {
  const rows = await db
    .select({ sprint_id: signingKeys.sprint_id })
    .from(signingKeys)
    .where(
      and(
        eq(signingKeys.key_kind, 'sub'),
        eq(signingKeys.install_id, installId),
        eq(signingKeys.status, 'active'),
        isNull(signingKeys.active_until),
      ),
    )
    .orderBy(desc(signingKeys.active_from))
    .limit(1)
  return rows[0]?.sprint_id ?? null
}

export async function runKeysRotate(options: KeysRotateOptions = {}): Promise<KeysRotateResult> {
  info('orbital keys rotate')
  const installId = await getInstallId()

  let sprintId = options.sprintId
  if (!sprintId) {
    const found = await findLatestActiveSprint(installId)
    if (!found) {
      if (!options.keepDbOpen) await closeDb()
      exitWithError(
        'no active sub-key found; supply --sprint <sprint-id> to rotate a specific sprint',
      )
    }
    sprintId = found
    info(`  no --sprint provided; rotating most recent active sprint (sprint_id=${sprintId})`)
  }

  const eventStore = createEventStore(db, sql)
  const km = new KeyManager(installId, eventStore)

  const result = await km.rotate(sprintId, SYSTEM_ACTOR)

  const rotatedRows = await db
    .select({ event_id: events.eventId })
    .from(events)
    .where(and(eq(events.aggregateId, result.newKeyId), eq(events.eventType, 'KeyRotated')))
    .orderBy(desc(events.occurredAt))
    .limit(1)
  const rotatedEventId = rotatedRows[0]?.event_id ?? ''
  if (!rotatedEventId) {
    warn('rotation succeeded but no KeyRotated event was found — investigate audit log')
  }

  const historyRows = await db
    .select()
    .from(keyHistory)
    .where(eq(keyHistory.key_id, result.newKeyId))
    .limit(1)
  if (historyRows.length === 0) {
    warn(
      `rotation produced new key ${result.newKeyId} but no key_history row — investigate immediately`,
    )
  }

  info(`  retired key: ${result.retiredKeyId || '(none — first rotation)'}`)
  info(`  new key:     ${result.newKeyId}`)
  info(`  event:       ${rotatedEventId}`)

  if (!options.keepDbOpen) {
    await closeDb()
  }

  return {
    retiredKeyId: result.retiredKeyId,
    newKeyId: result.newKeyId,
    rotatedEventId,
    sprintId,
  }
}
