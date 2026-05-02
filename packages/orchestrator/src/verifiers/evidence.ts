/**
 * verifiers/evidence.ts — persistence module for AC check evidence.
 *
 * Per Round 5C spec and architecture.md.
 *
 * Responsibilities:
 *   - recordEvidence(): persist a single ACCheckEvidence row + emit
 *     VerifierEvidenceRecorded event.
 *   - latestForAc(): read the most recent evidence row for an ac_id.
 *   - listForVerification(): read all evidence rows for a verification.
 *
 * The verifier worker calls recordEvidence() once per AC. The UAT UI calls
 * latestForAc() through the `uat.ac.evidence` tRPC query.
 *
 * All event emission goes through EventStore.append (project rule: no direct
 * INSERT into the events table).
 */

import { uuidv7 } from 'uuidv7'
import { desc, eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import {
  acCheckEvidence,
  type ACCheckEvidenceRow,
  type ACEvidenceKind,
  type ACEvidenceResult,
  type CIConclusion,
  CI_CONCLUSION,
} from '../db/schema/ac-check-evidence.js'
import { logger } from '../config/logger.js'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Per-AC evidence captured by the verifier. Mirrors the schema row shape but
 * uses snake_case where the rest of the codebase does (matches the brief).
 */
export interface ACCheckEvidence {
  ac_id: string
  ac_title: string
  result: ACEvidenceResult
  evidence_kind: ACEvidenceKind
  test_command?: string
  test_output?: string
  test_exit_code?: number
  llm_reasoning?: string
  files_inspected?: string[]
  /**
   * Round 6 #6 CI bridge fields — only set when evidence_kind='ci_run'.
   * [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
   */
  ci_run_url?: string | null
  ci_check_name?: string | null
  ci_conclusion?: string | null
}

export interface RecordEvidenceParams {
  /** The verification this evidence belongs to. */
  verificationId: string
  /** The ACCheckEvidence to persist. */
  evidence: ACCheckEvidence
  /** Trace id for log correlation. */
  traceId: string
  /** Actor recording the evidence (typically the verifier worker). */
  actor: { type: 'persona'; persona_id: string; session_id: string; task_id?: string }
}

export interface EvidenceStore {
  recordEvidence(params: RecordEvidenceParams): Promise<string>
  latestForAc(acId: string): Promise<ACCheckEvidenceRow | null>
  listForVerification(verificationId: string): Promise<ACCheckEvidenceRow[]>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class EvidenceStoreImpl implements EvidenceStore {
  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
  ) {}

  async recordEvidence(params: RecordEvidenceParams): Promise<string> {
    const { verificationId, evidence, traceId, actor } = params
    const evidenceId = uuidv7()
    const now = new Date()

    await this.db.insert(acCheckEvidence).values({
      evidenceId,
      verificationId,
      acId: evidence.ac_id,
      result: evidence.result,
      evidenceKind: evidence.evidence_kind,
      testCommand: evidence.test_command ?? null,
      testOutput: evidence.test_output ?? null,
      testExitCode: evidence.test_exit_code ?? null,
      llmReasoning: evidence.llm_reasoning ?? null,
      ciRunUrl: evidence.ci_run_url ?? null,
      ciCheckName: evidence.ci_check_name ?? null,
      // Cast to CIConclusion if the value is in the allowed set, else null
      ciConclusion: (evidence.ci_conclusion && (CI_CONCLUSION as readonly string[]).includes(evidence.ci_conclusion)
        ? evidence.ci_conclusion as CIConclusion
        : null),
      filesInspected: evidence.files_inspected ?? [],
      createdAt: now,
    })

    // Emit VerifierEvidenceRecorded so downstream consumers (UAT UI live
    // updates, audit reporters) see it. Best-effort — failure to emit must
    // not roll back the persisted row.
    try {
      await this.eventStore.append({
        aggregate_id: verificationId,
        aggregate_type: 'verification',
        event_type: 'VerifierEvidenceRecorded',
        payload: {
          schema_version: 1,
          verification_id: verificationId,
          evidence_id: evidenceId,
          ac_id: evidence.ac_id,
          ac_title: evidence.ac_title,
          result: evidence.result,
          evidence_kind: evidence.evidence_kind,
          // Test fields are deliberately omitted from the event payload to keep
          // event rows compact; the full body lives in audit.ac_check_evidence.
        },
        actor,
        trace_id: traceId,
        occurred_at: now.toISOString(),
        schema_version: 1,
      })
    } catch (err) {
      logger.warn(
        { err, verificationId, evidenceId, acId: evidence.ac_id },
        'EvidenceStore.recordEvidence: VerifierEvidenceRecorded emit failed (non-fatal)',
      )
    }

    return evidenceId
  }

  async latestForAc(acId: string): Promise<ACCheckEvidenceRow | null> {
    const rows = await this.db
      .select()
      .from(acCheckEvidence)
      .where(eq(acCheckEvidence.acId, acId))
      .orderBy(desc(acCheckEvidence.createdAt))
      .limit(1)
    return rows[0] ?? null
  }

  async listForVerification(verificationId: string): Promise<ACCheckEvidenceRow[]> {
    return this.db
      .select()
      .from(acCheckEvidence)
      .where(eq(acCheckEvidence.verificationId, verificationId))
      .orderBy(desc(acCheckEvidence.createdAt))
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createEvidenceStore(db: DB, eventStore: EventStore): EvidenceStore {
  return new EvidenceStoreImpl(db, eventStore)
}
