/**
 * evidence.test.ts — integration test for EvidenceStoreImpl.
 *
 * Uses real Postgres (consistent with the project's other verifier tests).
 *
 * Coverage:
 *   - recordEvidence persists a row to audit.ac_check_evidence
 *   - recordEvidence emits VerifierEvidenceRecorded via EventStore
 *   - latestForAc returns the most recent row for an ac_id
 *   - listForVerification returns all rows for a verification
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { eq, and } from 'drizzle-orm'
import { db, sql } from '../../../src/db/client.js'
import { createEventStore } from '../../../src/events/store.js'
import { EvidenceStoreImpl } from '../../../src/verifiers/evidence.js'
import { acCheckEvidence } from '../../../src/db/schema/ac-check-evidence.js'
import { events } from '../../../src/db/schema/events.js'

let eventStore: ReturnType<typeof createEventStore>
let store: EvidenceStoreImpl

beforeAll(async () => {
  eventStore = createEventStore(db, sql)
  store = new EvidenceStoreImpl(db, eventStore)
})

afterAll(async () => {
  await sql.end()
})

function makeActor(taskId: string) {
  return {
    type: 'persona' as const,
    persona_id: 'verifier',
    session_id: uuidv7(),
    task_id: taskId,
  }
}

describe('EvidenceStore', () => {
  describe('recordEvidence', () => {
    it('persists an audit.ac_check_evidence row', async () => {
      const verificationId = uuidv7()
      const acId = uuidv7()
      const taskId = uuidv7()

      const evidenceId = await store.recordEvidence({
        verificationId,
        evidence: {
          ac_id: acId,
          ac_title: 'Login redirects to dashboard',
          result: 'pass',
          evidence_kind: 'test_run',
          test_command: 'npx vitest run src/auth/login.test.ts',
          test_output: 'PASS  src/auth/login.test.ts (1 test passed)\n',
          test_exit_code: 0,
          files_inspected: ['src/auth/login.test.ts'],
        },
        traceId: uuidv7(),
        actor: makeActor(taskId),
      })

      expect(evidenceId).toBeTruthy()

      const rows = await db
        .select()
        .from(acCheckEvidence)
        .where(eq(acCheckEvidence.evidenceId, evidenceId))
      expect(rows.length).toBe(1)
      expect(rows[0]!.result).toBe('pass')
      expect(rows[0]!.evidenceKind).toBe('test_run')
      expect(rows[0]!.testExitCode).toBe(0)
      expect(rows[0]!.acId).toBe(acId)
    })

    it('emits VerifierEvidenceRecorded event', async () => {
      const verificationId = uuidv7()
      const acId = uuidv7()

      const evidenceId = await store.recordEvidence({
        verificationId,
        evidence: {
          ac_id: acId,
          ac_title: 'Some AC',
          result: 'fail',
          evidence_kind: 'test_run',
          test_command: 'npx vitest run',
          test_exit_code: 1,
        },
        traceId: uuidv7(),
        actor: makeActor(uuidv7()),
      })

      // Give the event a moment to land.
      await new Promise((r) => setTimeout(r, 50))

      const evRows = await db
        .select()
        .from(events)
        .where(
          and(
            eq(events.eventType, 'VerifierEvidenceRecorded'),
            eq(events.aggregateId, verificationId),
          ),
        )

      expect(evRows.length).toBe(1)
      const payload = evRows[0]!.payload as Record<string, unknown>
      expect(payload['evidence_id']).toBe(evidenceId)
      expect(payload['result']).toBe('fail')
      expect(payload['evidence_kind']).toBe('test_run')
      expect(payload['ac_id']).toBe(acId)
    })

    it('persists llm_reasoning when evidence_kind=llm_inspection', async () => {
      const verificationId = uuidv7()
      const acId = uuidv7()

      const evidenceId = await store.recordEvidence({
        verificationId,
        evidence: {
          ac_id: acId,
          ac_title: 'AC with LLM verdict',
          result: 'ambiguous',
          evidence_kind: 'llm_inspection',
          llm_reasoning: 'The diff shows X but the AC requires Y. Cannot determine.',
        },
        traceId: uuidv7(),
        actor: makeActor(uuidv7()),
      })

      const rows = await db
        .select()
        .from(acCheckEvidence)
        .where(eq(acCheckEvidence.evidenceId, evidenceId))
      expect(rows[0]!.llmReasoning).toContain('Cannot determine')
      expect(rows[0]!.evidenceKind).toBe('llm_inspection')
    })
  })

  describe('latestForAc', () => {
    it('returns the most recent evidence row for an ac_id', async () => {
      const verificationId = uuidv7()
      const acId = uuidv7()

      // First (older) recording.
      await store.recordEvidence({
        verificationId,
        evidence: {
          ac_id: acId,
          ac_title: 'Re-verified AC',
          result: 'fail',
          evidence_kind: 'test_run',
          test_exit_code: 1,
        },
        traceId: uuidv7(),
        actor: makeActor(uuidv7()),
      })

      // Brief gap so the timestamps differ.
      await new Promise((r) => setTimeout(r, 5))

      // Second (newer) recording.
      await store.recordEvidence({
        verificationId,
        evidence: {
          ac_id: acId,
          ac_title: 'Re-verified AC',
          result: 'pass',
          evidence_kind: 'test_run',
          test_exit_code: 0,
        },
        traceId: uuidv7(),
        actor: makeActor(uuidv7()),
      })

      const latest = await store.latestForAc(acId)
      expect(latest).toBeTruthy()
      expect(latest!.result).toBe('pass')
    })

    it('returns null for an unknown ac_id', async () => {
      const result = await store.latestForAc(uuidv7())
      expect(result).toBeNull()
    })
  })

  describe('listForVerification', () => {
    it('returns all evidence rows for a verification', async () => {
      const verificationId = uuidv7()

      for (let i = 0; i < 3; i++) {
        await store.recordEvidence({
          verificationId,
          evidence: {
            ac_id: uuidv7(),
            ac_title: `AC ${i}`,
            result: i % 2 === 0 ? 'pass' : 'fail',
            evidence_kind: 'test_run',
            test_exit_code: i % 2 === 0 ? 0 : 1,
          },
          traceId: uuidv7(),
          actor: makeActor(uuidv7()),
        })
      }

      const rows = await store.listForVerification(verificationId)
      expect(rows.length).toBe(3)
    })
  })
})
