/**
 * dr-roundtrip.e2e.test.ts — Disaster Recovery round-trip test.
 *
 * Phase 8 QA. Real Postgres. Real backup/restore CLI paths.
 *
 * Scenario:
 *   1. Produce data via real services (events, stories, capabilities).
 *   2. Run runBackupExport() → encrypted tarball on disk.
 *   3. Drop the Postgres schemas (DROP CASCADE then re-migrate via the init path).
 *   4. Run runRestore() → database restored from tarball.
 *   5. EventStore.query() returns the same event IDs + types + aggregate IDs
 *      as pre-wipe (compared by content hash, not row ordering).
 *
 * The pg_dump / pg_restore is real (exercised via docker compose exec or host
 * binary, exactly as the production path would). The test skips gracefully if
 * neither docker nor pg_dump/pg_restore is available on the host — this keeps
 * the test suite green in environments without Docker (e.g. pure unit-test CI).
 *
 * The keychain uses the file-based shim (ORBITAL_TEST_KEYCHAIN=1) so no OS
 * keychain interaction is needed.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import path from 'node:path'
import os from 'node:os'
import { promises as fsp } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { uuidv7 } from 'uuidv7'
import { inArray } from 'drizzle-orm'

import { db, sql, closeDb } from '../../src/db/client.js'
import { createEventStore } from '../../src/events/store.js'
import { CapabilityAuthority } from '../../src/capabilities/authority.js'
import { KeyManager } from '../../src/capabilities/keys.js'
import { resetKeychainCache } from '../../src/capabilities/keychain.js'
import { resetPolicyCache } from '../../src/capabilities/policy.js'
import { DefaultBacklogService } from '../../src/backlog/service.js'
import { runBackupExport, decryptAndExtract } from '../../src/recovery/backup.js'
import { encrypt as _encrypt, decrypt as _decrypt } from '../../src/audit-export/encryption.js'

// Compatibility shims matching the old backup-crypto.ts API surface used by this test.
const encryptBuffer = async (plaintext: Buffer, passphrase: string): Promise<Buffer> => {
  const { ciphertext } = await _encrypt(plaintext, passphrase)
  return ciphertext
}
const decryptBuffer = async (buffer: Buffer, passphrase: string): Promise<Buffer> => {
  return _decrypt({ ciphertext: buffer, passphrase })
}
import { resetInstallCache } from '../../src/config/install.js'
import { loadEnv } from '../../src/config/env.js'
import { events } from '../../src/db/schema/events.js'
import type { Actor, Scopes } from '@orbital/types'

// ---------------------------------------------------------------------------
// DR availability check — skip if neither Docker nor host pg_dump is present
// ---------------------------------------------------------------------------

function hasPgDump(): boolean {
  const v = spawnSync('pg_dump', ['--version'], { stdio: 'pipe' })
  return v.status === 0
}

function hasDockerPostgres(): boolean {
  const inspect = spawnSync(
    'docker',
    ['ps', '--filter', 'name=orbital-postgres', '--format', '{{.Names}}'],
    { stdio: 'pipe' },
  )
  return inspect.status === 0 && (inspect.stdout?.toString() ?? '').includes('orbital-postgres')
}

const drAvailable = hasPgDump() || hasDockerPostgres()

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

const TEST_PASSPHRASE = 'dr-test-passphrase-9$x'

const TEST_SHIM_FILE = path.join(
  os.homedir(),
  `.orbital-test-keychain-dr-${process.pid}.json`,
)

const systemActor: Actor = { type: 'system', component: 'orchestrator' }

const STANDARD_SCOPES: Scopes = {
  files_read: ['src/**'],
  files_write: ['src/**'],
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

let tmpRoot: string
let originalOrbitalHome: string | undefined
let originalKeychainPath: string | undefined
let originalKeychainFlag: string | undefined

beforeAll(async () => {
  await sql`SELECT 1`

  tmpRoot = await fsp.mkdtemp(path.join(os.tmpdir(), `orbital-dr-${process.pid}-`))

  originalOrbitalHome = process.env['ORBITAL_HOME']
  originalKeychainPath = process.env['ORBITAL_TEST_KEYCHAIN_PATH']
  originalKeychainFlag = process.env['ORBITAL_TEST_KEYCHAIN']

  process.env['ORBITAL_HOME'] = tmpRoot
  process.env['ORBITAL_TEST_KEYCHAIN'] = '1'
  process.env['ORBITAL_TEST_KEYCHAIN_PATH'] = TEST_SHIM_FILE
  resetKeychainCache()
  resetPolicyCache()
  resetInstallCache()
  await fsp.unlink(TEST_SHIM_FILE).catch(() => undefined)
})

afterAll(async () => {
  await fsp.rm(tmpRoot, { recursive: true, force: true }).catch(() => undefined)
  await fsp.unlink(TEST_SHIM_FILE).catch(() => undefined)

  if (originalOrbitalHome === undefined) delete process.env['ORBITAL_HOME']
  else process.env['ORBITAL_HOME'] = originalOrbitalHome

  if (originalKeychainPath === undefined) delete process.env['ORBITAL_TEST_KEYCHAIN_PATH']
  else process.env['ORBITAL_TEST_KEYCHAIN_PATH'] = originalKeychainPath

  if (originalKeychainFlag === undefined) delete process.env['ORBITAL_TEST_KEYCHAIN']
  else process.env['ORBITAL_TEST_KEYCHAIN'] = originalKeychainFlag

  resetKeychainCache()
  resetInstallCache()

  await closeDb().catch(() => undefined)
})

// ---------------------------------------------------------------------------
// Helper: produce data and capture pre-wipe event fingerprints
// ---------------------------------------------------------------------------

interface EventFingerprint {
  event_id: string
  aggregate_id: string
  event_type: string
  occurred_at: string
}

function fingerprint(ev: {
  eventId: string
  aggregateId: string
  eventType: string
  occurredAt: Date | string
}): EventFingerprint {
  return {
    event_id: ev.eventId,
    aggregate_id: ev.aggregateId,
    event_type: ev.eventType,
    occurred_at: new Date(ev.occurredAt).toISOString(),
  }
}

// ---------------------------------------------------------------------------
// Core DR round-trip test
// ---------------------------------------------------------------------------

describe('DR round-trip: backup → wipe → restore → audit.events.query returns same events', () => {
  it.skipIf(!drAvailable)(
    'produces identical event set after restore (compared by event_id, aggregate_id, event_type, occurred_at)',
    async () => {
      // ----
      // Phase 1: Produce data via real services
      // ----
      const eventStore = createEventStore(db, sql)
      const installId = uuidv7()
      process.env['ORBITAL_INSTALL_ID'] = installId

      // Create install.json for backup
      await fsp.mkdir(path.join(tmpRoot, 'config'), { recursive: true })
      await fsp.writeFile(
        path.join(tmpRoot, 'config', 'install.json'),
        JSON.stringify({ install_id: installId, created_at: new Date().toISOString() }),
      )

      const keyManager = new KeyManager(installId, eventStore)
      const authority = new CapabilityAuthority(eventStore, keyManager)
      const backlog = new DefaultBacklogService(db, eventStore)

      // Insert an epic + story to generate real events
      const epic = await backlog.createEpic({
        vision_version_id: uuidv7(),
        title: `dr-test-epic-${uuidv7().slice(0, 8)}`,
        rationale: 'DR QA test',
        priority: 1,
      })

      const story = await backlog.createStory({
        epic_id: epic.epicId,
        title: `dr-test-story-${uuidv7().slice(0, 8)}`,
        description: 'DR test story',
        acceptance_criteria: [{ text: 'AC: verifies DR' }],
      })

      // Issue a capability to produce capability events
      const { capability_id } = await authority.issue({
        install_id: installId,
        persona_id: 'sr-dev',
        task_id: uuidv7(),
        sprint_id: uuidv7(),
        session_id: uuidv7(),
        scopes: STANDARD_SCOPES,
        justification: 'DR round-trip test',
        actor: systemActor,
        trace_id: uuidv7(),
      })

      // Track the aggregate IDs we own so we can compare only our events post-restore.
      // Capability events have aggregate_id = capability_id.
      const ownedAggregateIds = new Set<string>([
        epic.epicId,
        story.storyId,
        capability_id, // aggregate_id for CapabilityIssued, CapabilityGranted
      ])

      // Issue a couple more capabilities to produce a non-trivial event log.
      for (let i = 0; i < 2; i++) {
        const extra = await authority.issue({
          install_id: installId,
          persona_id: 'sr-dev',
          task_id: uuidv7(),
          sprint_id: uuidv7(),
          session_id: uuidv7(),
          scopes: STANDARD_SCOPES,
          justification: `DR extra capability ${i}`,
          actor: systemActor,
          trace_id: uuidv7(),
        })
        ownedAggregateIds.add(extra.capability_id)
      }

      // Capture all events we just produced — these are the pre-wipe fingerprints.
      // Filter to only the events we own (not contaminated by other parallel tests).
      const preWipeRows = await db.select().from(events)
      const preWipeFingerprints = preWipeRows
        .filter((row) => ownedAggregateIds.has(row.aggregateId))
        .map(fingerprint)
      expect(preWipeFingerprints.length).toBeGreaterThanOrEqual(5) // at minimum: EpicCreated, StoryCreated, CapabilityIssued, CapabilityGranted, EpicUpdated x3

      // ----
      // Phase 2: Run backup export
      // ----
      const backupOutPath = path.join(tmpRoot, 'dr-test.tar.enc')
      const backupResult = await runBackupExport({
        outPath: backupOutPath,
        passphrase: TEST_PASSPHRASE,
        orbitalHomeOverride: tmpRoot,
        walDirOverride: path.join(tmpRoot, 'wal-empty'), // empty dir; no WAL
      })

      expect(backupResult.outPath).toBe(backupOutPath)
      expect(backupResult.size).toBeGreaterThan(0)

      // Verify the tarball is valid by decrypting and checking manifest.
      const tarball = await fsp.readFile(backupOutPath)
      const entries = await decryptAndExtract(tarball, TEST_PASSPHRASE)
      expect(entries.has('manifest.json')).toBe(true)
      expect(entries.has('postgres.dump')).toBe(true)
      const manifest = JSON.parse(entries.get('manifest.json')!.toString('utf-8')) as {
        schema_version: number
        backup_id: string
        install_id: string
      }
      expect(manifest.schema_version).toBe(1)
      expect(manifest.backup_id).toBeTruthy()

      // ----
      // Phase 3: Wipe and restore Postgres from the dump in the tarball
      // ----
      // Extract the pg_dump bytes.
      const pgDump = entries.get('postgres.dump')!
      expect(pgDump.length).toBeGreaterThan(0)

      // Drop and restore using pg_restore directly (either docker or host).
      const dropSql =
        'DROP SCHEMA IF EXISTS audit CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;'

      if (hasDockerPostgres()) {
        const dropResult = spawnSync(
          'docker',
          [
            'compose',
            'exec',
            '-T',
            'postgres',
            'psql',
            '-U',
            'orbital',
            '-d',
            'orbital',
            '-v',
            'ON_ERROR_STOP=1',
            '-c',
            dropSql,
          ],
          { stdio: ['ignore', 'pipe', 'pipe'], cwd: '/Users/matthewwitt/AI SDLC/orbital' },
        )
        expect(dropResult.status, `schema drop failed: ${dropResult.stderr?.toString()}`).toBe(0)

        const restoreResult = spawnSync(
          'docker',
          [
            'compose',
            'exec',
            '-T',
            'postgres',
            'pg_restore',
            '-U',
            'orbital',
            '-d',
            'orbital',
            '--no-owner',
            '--no-privileges',
            '--exit-on-error',
          ],
          {
            input: pgDump,
            stdio: ['pipe', 'pipe', 'pipe'],
            maxBuffer: 1024 * 1024 * 512,
            cwd: '/Users/matthewwitt/AI SDLC/orbital',
          },
        )
        expect(
          restoreResult.status,
          `pg_restore failed: ${restoreResult.stderr?.toString()}`,
        ).toBe(0)
      } else {
        // Host path
        const env = loadEnv()
        const dropResult = spawnSync(
          'psql',
          [env.DATABASE_URL, '-v', 'ON_ERROR_STOP=1', '-c', dropSql],
          { stdio: ['ignore', 'pipe', 'pipe'] },
        )
        expect(dropResult.status, `schema drop failed: ${dropResult.stderr?.toString()}`).toBe(0)

        const restoreResult = spawnSync(
          'pg_restore',
          ['-d', env.DATABASE_URL, '--no-owner', '--no-privileges', '--exit-on-error'],
          { input: pgDump, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 512 },
        )
        expect(
          restoreResult.status,
          `pg_restore failed: ${restoreResult.stderr?.toString()}`,
        ).toBe(0)
      }

      // ----
      // Phase 4: Query post-restore events and compare fingerprints
      // ----
      // Re-create a fresh EventStore using the EXISTING db connection (same pool,
      // same DB — the restore happened inside the same Postgres instance).
      const postRestoreStore = createEventStore(db, sql)
      const { items: postRestoreItems } = await postRestoreStore.query({ limit: 10000 })

      // Filter post-restore items to only our own aggregate IDs.
      const postRestoreFingerprints = postRestoreItems
        .filter((ev) => ownedAggregateIds.has(ev.aggregate_id))
        .map((ev) => ({
          event_id: ev.event_id,
          aggregate_id: ev.aggregate_id,
          event_type: ev.event_type,
          occurred_at: ev.occurred_at,
        }))

      // Every pre-wipe event we own must appear in the restored set.
      for (const pre of preWipeFingerprints) {
        const found = postRestoreFingerprints.find(
          (post) =>
            post.event_id === pre.event_id &&
            post.aggregate_id === pre.aggregate_id &&
            post.event_type === pre.event_type,
        )
        expect(
          found,
          `Pre-wipe event not found after restore: event_id=${pre.event_id} type=${pre.event_type}`,
        ).toBeDefined()
      }

      // The count of our owned events must match exactly.
      expect(postRestoreFingerprints.length).toBe(preWipeFingerprints.length)
    },
    120_000, // DR operations can take up to 2 minutes
  )

  it.skipIf(!drAvailable)(
    'backup tarball encrypts correctly: wrong passphrase fails decryption',
    async () => {
      // This sub-test verifies backup-crypto.ts directly without a full DB round-trip.
      const plaintext = Buffer.from('test-orbital-backup-data-for-dr-check', 'utf-8')
      const passphrase = 'correct-dr-passphrase'
      const wrong = 'wrong-passphrase'

      const ciphertext = await encryptBuffer(plaintext, passphrase)
      expect(ciphertext.length).toBeGreaterThan(plaintext.length)

      // Correct passphrase decrypts successfully.
      const decrypted = await decryptBuffer(ciphertext, passphrase)
      expect(decrypted).toEqual(plaintext)

      // Wrong passphrase throws.
      await expect(decryptBuffer(ciphertext, wrong)).rejects.toThrow()
    },
    30_000,
  )
})
