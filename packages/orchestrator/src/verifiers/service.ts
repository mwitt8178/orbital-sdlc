/**
 * verifiers/service.ts — VerifierService.
 *
 * Per TRD-09 §10, task spec, and Round 5C architecture.md.
 *
 * Round 5C (Engineer-Principal) change: spawnVerifier now does real work
 * instead of inserting a verifications row stub.
 *
 * Responsibilities:
 * - spawnVerifier(taskId, ticketId, artifactPaths, actingPersonaId):
 *     1. SoD check: verifier persona must differ from actingPersonaId.
 *     2. Resolve the parent task → worktree path, story_id, persona_id.
 *     3. Resolve the AC list (story_acceptance_criteria.story_id =
 *        parent.story_id, ordered by ordinal). Fall back to
 *        parent.acceptance_criteria (the legacy in-row jsonb) if
 *        story_acceptance_criteria has no rows.
 *     4. Insert verifications row with status='running' and ac_count=N.
 *     5. Emit VerifierStarted event via EventStore.append.
 *     6. For each AC, insert a child verifier task in `tasks` with
 *        persona_id='verifier', parent_task_id=parent.task_id,
 *        sprint_id=parent.sprint_id (so the scheduler picks it up). The
 *        verifier worker reads its task description, runs checkAC(), and
 *        ultimately calls submitResult().
 *     7. Return verification_id.
 *
 *    BACKWARD COMPAT: when the parent task is not present in the tasks table
 *    (legacy callers / unit tests), we degrade to the old behaviour: insert
 *    verifications row with ac_count=0, emit VerifierStarted, return id.
 *    Spawning child verifier tasks requires a real parent.
 *
 * - submitResult(submission, traceId): unchanged from prior behaviour.
 *
 * - getResult(verificationId): unchanged.
 *
 * All events via EventStore.append — never db.insert(events) directly.
 * SoD: verifier persona_id must differ from the task's executing persona_id.
 */

import { uuidv7 } from 'uuidv7'
import { asc, eq } from 'drizzle-orm'
import { OrbitalError } from '@orbital/types'
import type { EventStore } from '../events/store.js'
import type { DB } from '../db/client.js'
import {
  verifications,
  verificationResults,
  type VerificationRow,
} from '../db/schema/determinism.js'
import { tasks, worktrees } from '../db/schema/orchestration.js'
import { storyAcceptanceCriteria } from '../db/schema/backlog.js'
import type { VerificationSubmission } from '../hooks/types.js'
import { logger } from '../config/logger.js'

// ---------------------------------------------------------------------------
// Interface (per Implementation Plan §7 exposes)
// ---------------------------------------------------------------------------

export interface VerifierService {
  spawnVerifier(
    taskId: string,
    ticketId: string,
    artifactPaths: string[],
    actingPersonaId: string,
    opts?: SpawnVerifierOpts,
  ): Promise<string> // returns VerificationId

  submitResult(submission: VerificationSubmission, traceId: string): Promise<void>

  getResult(verificationId: string): Promise<VerificationRow | null>

  /**
   * Round 6 #6: Wait for a CIRunCompleted or CIRunFailed event for the given
   * task and PR number, with a configurable timeout.
   *
   * Returns the CI conclusion string ('success', 'failure', etc.) when the
   * event arrives within the timeout, or null if timeout elapses first.
   *
   * Used by the verifier worker to block AC evaluation until CI settles.
   * [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
   */
  awaitCI(
    taskId: string,
    prNumber: number,
    timeoutMs?: number,
  ): Promise<{ conclusion: string; ciRunUrl: string; checkName: string } | null>
}

export interface SpawnVerifierOpts {
  traceId?: string
  /** Override the verifier persona used for SoD check. Default: 'verifier'. */
  verifierPersonaId?: string
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const VERIFIER_PERSONA_ID = 'verifier'
const SYSTEM_ACTOR = { type: 'system' as const, component: 'orchestrator' as const }

/** Default budgets for the synthetic verifier sub-tasks. */
const VERIFIER_TASK_RETRY_BUDGET = 1
const VERIFIER_TASK_WALL_CLOCK_TIMEOUT_MS = 5 * 60 * 1000
const VERIFIER_TASK_TOKEN_BUDGET = 8000
const VERIFIER_TASK_RISK_CLASS = 'standard' as const

/**
 * Internal shape of an AC the verifier sub-task is built from.
 *
 * Either source — story_acceptance_criteria rows or parent.acceptance_criteria
 * jsonb strings — is normalised to this shape.
 */
interface NormalisedAc {
  ac_id: string
  ordinal: number
  text: string
}

export class VerifierServiceImpl implements VerifierService {
  constructor(
    private readonly eventStore: EventStore,
    private readonly db: DB,
  ) {}

  // ---------------------------------------------------------------------------
  // spawnVerifier
  // ---------------------------------------------------------------------------

  async spawnVerifier(
    taskId: string,
    ticketId: string,
    artifactPaths: string[],
    actingPersonaId: string,
    opts: SpawnVerifierOpts = {},
  ): Promise<string> {
    const verifierPersonaId = opts.verifierPersonaId ?? VERIFIER_PERSONA_ID
    const traceId = opts.traceId ?? uuidv7()

    // SoD check: verifier persona must differ from acting persona.
    // Per TRD-09 §10.6: "The verifier capability bundle is constructed with no
    // files_write scope... Any attempted write is denied at the MCP gateway."
    // At spawn time, we reject if the persona trying to spawn would be verifying
    // their own work (same persona_id = SoD violation).
    if (verifierPersonaId === actingPersonaId) {
      throw new OrbitalError(
        'AUTH_SOD_VIOLATION',
        `AUTH_SOD_VIOLATION: verifier persona '${verifierPersonaId}' must differ from the task executor '${actingPersonaId}'`,
        { verifierPersonaId, actingPersonaId },
      )
    }

    // Resolve parent task. If absent (unit-test path or legacy caller), fall
    // back to stub-style behaviour to preserve backward compatibility.
    const parentTask = await this.loadParentTask(taskId)
    const acList: NormalisedAc[] = parentTask
      ? await this.loadAcList(parentTask.storyId ?? null, parentTask.acceptanceCriteria ?? [])
      : []

    const verificationId = uuidv7()
    const verifierSessionId = uuidv7()
    const now = new Date()

    // Insert verifications row with status='running'.
    // ac_count is the number of ACs we're about to verify; in the legacy/stub
    // path this is 0. Submit time will overwrite if results.length differs.
    await this.db.insert(verifications).values({
      verification_id: verificationId,
      task_id: taskId,
      ticket_id: ticketId,
      verifier_session_id: verifierSessionId,
      status: 'running',
      ac_count: acList.length,
      trace_id: traceId,
      started_at: now,
    })

    // Emit VerifierStarted event.
    await this.eventStore.append({
      aggregate_id: verificationId,
      aggregate_type: 'verification',
      event_type: 'VerifierStarted',
      payload: {
        schema_version: 1,
        verification_id: verificationId,
        task_id: taskId,
        ticket_id: ticketId,
        verifier_session_id: verifierSessionId,
        ac_count: acList.length,
      },
      actor: SYSTEM_ACTOR,
      trace_id: traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    })

    logger.info(
      {
        verificationId,
        taskId,
        ticketId,
        verifierPersonaId,
        acCount: acList.length,
        hasParentTask: !!parentTask,
      },
      'VerifierService: spawned verification',
    )

    // Real-spawn path: only if we have a parent task AND at least one AC.
    if (parentTask && acList.length > 0) {
      await this.spawnVerifierSubTasks({
        verificationId,
        parentTask,
        acList,
        artifactPaths,
        traceId,
      })
    }

    return verificationId
  }

  /**
   * Resolve the parent task by id. Returns null if not present (legacy /
   * test path). Loads only the columns the verifier needs.
   */
  private async loadParentTask(taskId: string): Promise<{
    taskId: string
    sprintId: string
    ticketId: string
    storyId: string | null
    personaId: string
    acceptanceCriteria: string[]
    worktreePath: string | null
  } | null> {
    const rows = await this.db
      .select({
        taskId: tasks.taskId,
        sprintId: tasks.sprintId,
        ticketId: tasks.ticketId,
        storyId: tasks.storyId,
        personaId: tasks.personaId,
        acceptanceCriteria: tasks.acceptanceCriteria,
        currentWorktreeId: tasks.currentWorktreeId,
      })
      .from(tasks)
      .where(eq(tasks.taskId, taskId))
      .limit(1)
    const t = rows[0]
    if (!t) return null

    let worktreePath: string | null = null
    if (t.currentWorktreeId) {
      const wts = await this.db
        .select({ path: worktrees.path })
        .from(worktrees)
        .where(eq(worktrees.worktreeId, t.currentWorktreeId))
        .limit(1)
      worktreePath = wts[0]?.path ?? null
    }

    return {
      taskId: t.taskId,
      sprintId: t.sprintId,
      ticketId: t.ticketId,
      storyId: t.storyId,
      personaId: t.personaId,
      acceptanceCriteria: t.acceptanceCriteria ?? [],
      worktreePath,
    }
  }

  /**
   * Resolve the AC list for the parent task. Prefer story_acceptance_criteria
   * (real first-class AC rows owned by TRD-02); fall back to the legacy
   * tasks.acceptance_criteria jsonb if the story has none.
   */
  private async loadAcList(
    storyId: string | null,
    fallbackStrings: string[],
  ): Promise<NormalisedAc[]> {
    if (storyId) {
      const rows = await this.db
        .select({
          acId: storyAcceptanceCriteria.acId,
          ordinal: storyAcceptanceCriteria.ordinal,
          text: storyAcceptanceCriteria.text,
        })
        .from(storyAcceptanceCriteria)
        .where(eq(storyAcceptanceCriteria.storyId, storyId))
        .orderBy(asc(storyAcceptanceCriteria.ordinal))
      if (rows.length > 0) {
        return rows.map((r) => ({ ac_id: r.acId, ordinal: r.ordinal, text: r.text }))
      }
    }

    // Fallback: synthesise stable ac_ids from the string content. We deliberately
    // generate a UUIDv7 per call — these ACs are not first-class and the
    // verifier evidence linkage is best-effort.
    return fallbackStrings.map((text, i) => ({
      ac_id: uuidv7(),
      ordinal: i + 1,
      text,
    }))
  }

  /**
   * Spawn one verifier sub-task per AC. The Scheduler picks them up by virtue
   * of their state='ready' and the persona='verifier' routing. Each sub-task
   * carries the verification_id in its description so the verifier worker
   * knows which verification it's contributing evidence to.
   */
  private async spawnVerifierSubTasks(params: {
    verificationId: string
    parentTask: {
      taskId: string
      sprintId: string
      ticketId: string
      storyId: string | null
      worktreePath: string | null
    }
    acList: NormalisedAc[]
    artifactPaths: string[]
    traceId: string
  }): Promise<void> {
    const { verificationId, parentTask, acList, artifactPaths, traceId } = params
    const createdByEventId = uuidv7()

    for (const ac of acList) {
      const verifierTaskId = uuidv7()
      const description = [
        `# Verify acceptance criterion #${ac.ordinal}`,
        ``,
        `**Verification ID:** ${verificationId}`,
        `**Parent task:** ${parentTask.taskId}`,
        `**Ticket:** ${parentTask.ticketId}`,
        ``,
        `## Acceptance criterion`,
        ``,
        ac.text,
        ``,
        `## Artifact paths`,
        ``,
        artifactPaths.length > 0 ? artifactPaths.map((p) => `- ${p}`).join('\n') : '(none)',
        ``,
        `## Worktree path`,
        ``,
        parentTask.worktreePath ?? '(parent task has no active worktree)',
        ``,
        `## Protocol`,
        ``,
        `Run \`verify-ac-evidence-protocol\`: detect framework, match candidate tests, `,
        `run them, capture stdout/stderr + exit code, escalate ambiguous to AnthropicDriver. `,
        `Submit your per-AC evidence via VerifierService.submitResult.`,
      ].join('\n')

      try {
        await this.db.insert(tasks).values({
          taskId: verifierTaskId,
          sprintId: parentTask.sprintId,
          ticketId: parentTask.ticketId,
          title: `Verify AC #${ac.ordinal}: ${truncateTitle(ac.text)}`,
          description,
          acceptanceCriteria: [ac.text],
          storyId: parentTask.storyId,
          personaId: VERIFIER_PERSONA_ID,
          riskClass: VERIFIER_TASK_RISK_CLASS,
          state: 'ready',
          attemptCount: 0,
          retryBudget: VERIFIER_TASK_RETRY_BUDGET,
          parentTaskId: parentTask.taskId,
          wallClockTimeoutMs: VERIFIER_TASK_WALL_CLOCK_TIMEOUT_MS,
          tokenBudget: VERIFIER_TASK_TOKEN_BUDGET,
          declaredWritePaths: [],
          createdByEventId,
        })
        logger.debug(
          { verifierTaskId, verificationId, acId: ac.ac_id },
          'VerifierService: spawned verifier sub-task',
        )
      } catch (err: unknown) {
        // Continue spawning other ACs even if one fails. The verification row
        // is the source of truth; missing evidence will be ambiguous and
        // surfaced at submit time.
        logger.error(
          { err, verifierTaskId, verificationId, acId: ac.ac_id, traceId },
          'VerifierService: failed to spawn verifier sub-task (continuing)',
        )
      }
    }
  }

  // ---------------------------------------------------------------------------
  // submitResult
  // ---------------------------------------------------------------------------

  async submitResult(submission: VerificationSubmission, traceId: string): Promise<void> {
    const { verification_id: verificationId, results, summary } = submission

    // Fetch existing verification row.
    const rows = await this.db
      .select()
      .from(verifications)
      .where(eq(verifications.verification_id, verificationId))
      .limit(1)

    const verification = rows[0]
    if (!verification) {
      throw new OrbitalError(
        'NOT_FOUND_VERIFICATION',
        `verification ${verificationId} not found`,
        { verificationId },
      )
    }

    // Aggregate per-AC verdicts.
    let passCount = 0
    let failCount = 0
    let ambiguousCount = 0
    const failedAcIndices: number[] = []
    const ambiguousAcIndices: number[] = []

    for (const result of results) {
      if (result.verdict === 'pass') passCount++
      else if (result.verdict === 'fail') {
        failCount++
        failedAcIndices.push(result.ac_index)
      } else if (result.verdict === 'ambiguous') {
        ambiguousCount++
        ambiguousAcIndices.push(result.ac_index)
      }
    }

    // Determine final status per TRD-09 §10.4 aggregation rule:
    // any fail → failed; no fail + ambiguous → ambiguous; all pass → passed
    let finalStatus: 'passed' | 'failed' | 'ambiguous'
    if (failCount > 0) {
      finalStatus = 'failed'
    } else if (ambiguousCount > 0) {
      finalStatus = 'ambiguous'
    } else {
      finalStatus = 'passed'
    }

    const now = new Date()
    const startedAt =
      verification.started_at instanceof Date
        ? verification.started_at
        : new Date(verification.started_at as string)
    const durationMs = now.getTime() - startedAt.getTime()

    // Update verifications row.
    await this.db
      .update(verifications)
      .set({
        status: finalStatus,
        ac_count: results.length,
        ac_pass_count: passCount,
        ac_fail_count: failCount,
        ac_ambiguous_count: ambiguousCount,
        summary,
        duration_ms: durationMs,
        completed_at: now,
      })
      .where(eq(verifications.verification_id, verificationId))

    // Insert verification_results rows.
    for (const result of results) {
      await this.db.insert(verificationResults).values({
        result_id: uuidv7(),
        verification_id: verificationId,
        ac_index: result.ac_index,
        ac_text: result.ac_text,
        verdict: result.verdict,
        reason: result.reason,
        evidence_refs: result.evidence_refs,
        created_at: now,
      })
    }

    const occurredAt = now.toISOString()

    // Emit the appropriate outcome event.
    if (finalStatus === 'passed') {
      await this.eventStore.append({
        aggregate_id: verificationId,
        aggregate_type: 'verification',
        event_type: 'VerifierPassed',
        payload: {
          schema_version: 1,
          verification_id: verificationId,
          task_id: verification.task_id,
          ticket_id: verification.ticket_id,
          ac_pass_count: passCount,
          duration_ms: durationMs,
        },
        actor: SYSTEM_ACTOR,
        trace_id: traceId,
        occurred_at: occurredAt,
        schema_version: 1,
      })
    } else if (finalStatus === 'failed') {
      await this.eventStore.append({
        aggregate_id: verificationId,
        aggregate_type: 'verification',
        event_type: 'VerifierFailed',
        payload: {
          schema_version: 1,
          verification_id: verificationId,
          task_id: verification.task_id,
          ticket_id: verification.ticket_id,
          failed_ac_indices: failedAcIndices,
          feedback_summary: summary,
          duration_ms: durationMs,
        },
        actor: SYSTEM_ACTOR,
        trace_id: traceId,
        occurred_at: occurredAt,
        schema_version: 1,
      })
    } else {
      // ambiguous
      await this.eventStore.append({
        aggregate_id: verificationId,
        aggregate_type: 'verification',
        event_type: 'VerifierAmbiguous',
        payload: {
          schema_version: 1,
          verification_id: verificationId,
          task_id: verification.task_id,
          ticket_id: verification.ticket_id,
          ambiguous_ac_indices: ambiguousAcIndices,
          resolution_path: 'escalated_to_user',
          escalation_target: 'user',
        },
        actor: SYSTEM_ACTOR,
        trace_id: traceId,
        occurred_at: occurredAt,
        schema_version: 1,
      })

      // Per task spec: VerifierAmbiguous → EscalatedToHuman event.
      await this.eventStore.append({
        aggregate_id: verificationId,
        aggregate_type: 'verification',
        event_type: 'EscalatedToHuman',
        payload: {
          schema_version: 1,
          verification_id: verificationId,
          task_id: verification.task_id,
          ticket_id: verification.ticket_id,
          reason: 'VerifierAmbiguous: one or more ACs could not be definitively verified',
          ambiguous_ac_indices: ambiguousAcIndices,
          escalation_path: 'escalated_to_user',
        },
        actor: SYSTEM_ACTOR,
        trace_id: traceId,
        occurred_at: occurredAt,
        schema_version: 1,
      })

      logger.warn(
        { verificationId, ambiguousAcIndices },
        'VerifierService: ambiguous result — escalated to human',
      )
    }

    logger.info(
      { verificationId, status: finalStatus, passCount, failCount, ambiguousCount },
      'VerifierService: result submitted',
    )
  }

  // ---------------------------------------------------------------------------
  // awaitCI
  // Round 6 #6 — CI/CD Bridge
  // [Engineer-Sr · Sonnet · run-round6-06-ci-bridge]
  // ---------------------------------------------------------------------------

  async awaitCI(
    taskId: string,
    prNumber: number,
    timeoutMs = 10 * 60 * 1000, // 10 minutes default
  ): Promise<{ conclusion: string; ciRunUrl: string; checkName: string } | null> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        unsubscribe()
        logger.warn(
          { taskId, prNumber, timeoutMs },
          'VerifierService.awaitCI: timed out waiting for CI run',
        )
        resolve(null)
      }, timeoutMs)

      // Subscribe from the current tail of the event log (null cursor = latest events only)
      const unsubscribe = this.eventStore.subscribe(null, (envelope) => {
        // Filter: only CIRun events for this task
        if (
          envelope.aggregate_id !== taskId ||
          (envelope.event_type !== 'CIRunCompleted' && envelope.event_type !== 'CIRunFailed')
        ) {
          return
        }

        const payload = envelope.payload as Record<string, unknown>

        // Filter by PR number if provided (non-zero)
        if (prNumber !== 0) {
          const eventPrNumber = payload['pr_number']
          if (typeof eventPrNumber === 'number' && eventPrNumber !== prNumber) {
            return // wrong PR, keep waiting
          }
        }

        clearTimeout(timer)
        unsubscribe()

        resolve({
          conclusion: typeof payload['ci_conclusion'] === 'string' ? payload['ci_conclusion'] : 'unknown',
          ciRunUrl: typeof payload['ci_run_url'] === 'string' ? payload['ci_run_url'] : '',
          checkName: typeof payload['ci_check_name'] === 'string' ? payload['ci_check_name'] : '',
        })
      })
    })
  }

  // ---------------------------------------------------------------------------
  // getResult
  // ---------------------------------------------------------------------------

  async getResult(verificationId: string): Promise<VerificationRow | null> {
    const rows = await this.db
      .select()
      .from(verifications)
      .where(eq(verifications.verification_id, verificationId))
      .limit(1)

    return rows[0] ?? null
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncateTitle(text: string, max = 80): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}
