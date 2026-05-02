/**
 * vision/pm-stub.ts — PM persona stub-response service.
 *
 * Two execution modes:
 *
 * 1. **Templated** (dev / no API key) — deterministic PM_SCRIPT lines drive a
 *    fixed 5-turn intake flow. After turn 3 a skeleton draft is written.
 *
 * 2. **Anthropic-driver** (production / ANTHROPIC_API_KEY set) — every user
 *    message routes through AnthropicDriver.invoke() with a PM-vision prompt.
 *    The model can ask follow-ups, propose draft updates, or signal lock_ready.
 *
 * Both modes write real DB rows and emit real VisionMessageSent + (optionally)
 * VisionDrafted events — the only difference is whether the text is generated
 * by an LLM or by PM_SCRIPT.
 *
 * The "stub" refers only to the text being templated; the rest of the path is
 * production code.
 *
 * Configurable:
 *   VISION_PM_STUB_DELAY_MS — thinking delay in ms (templated mode; default 1200)
 */

import { uuidv7 } from 'uuidv7'
import { eq, and, asc } from 'drizzle-orm'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import {
  visionDocuments,
  visionVersions,
  visionSessions,
  visionMessages,
} from '../db/schema/vision.js'
import { computeContentHash } from './lifecycle.js'
import { VisionDocumentContentDraftSchema } from './types.js'
import { logger } from '../config/logger.js'
import type { VisionSessionId } from './types.js'
import { loadEnv } from '../config/env.js'
import type { AnthropicDriver } from '../personas/anthropic-driver.js'
import { AnthropicDriverNoKeyError } from '../personas/anthropic-driver.js'
import {
  buildPMVisionSystemPrompt,
  buildPMVisionUserPrompt,
  PMVisionResponseSchema,
  type PMVisionContext,
  type PMVisionResponse,
} from '../personas/prompts/pm-vision.js'

const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------------------
// PM script — deterministic per exchange count (1-indexed user message count)
// ---------------------------------------------------------------------------

const PM_SCRIPT: Record<number, string> = {
  1: 'Thanks for that. Who is the primary user, and what problem does this solve for them?',
  2: "What's the smallest version we could ship that proves the value? What's explicitly out of scope for v1?",
  3: 'Any non-functional constraints — performance, security, regulatory, mobile, accessibility?',
  4: "What's the success metric? How will we know v1 worked?",
}

const PM_WRAP_UP =
  "I think I have enough to draft. Click 'Lock vision' on the right to commit, or keep talking."

function pmReply(userMessageCount: number): string {
  return PM_SCRIPT[userMessageCount] ?? PM_WRAP_UP
}

// ---------------------------------------------------------------------------
// Stub-mode detection
// ---------------------------------------------------------------------------

/**
 * Returns true when the PM stub should respond.
 *
 * Stub fires when:
 *   (a) ANTHROPIC_API_KEY is absent / empty, OR
 *   (b) CLAUDE_BIN cannot be found on PATH (best-effort `which` check)
 *
 * In production — both set and working — returns false and the real PM worker
 * (spawned by the Scheduler) handles responses.
 *
 * NOTE: The CLAUDE_BIN check is cheap (shell `which`). It does not validate
 * the binary version or execute it.
 */
export async function isStubMode(): Promise<boolean> {
  const env = loadEnv()
  if (!env.ANTHROPIC_API_KEY) return true

  try {
    await execFileAsync('which', [env.CLAUDE_BIN], { timeout: 3000 })
    return false
  } catch {
    return true
  }
}

// ---------------------------------------------------------------------------
// VisionPMStub
// ---------------------------------------------------------------------------

export class VisionPMStub {
  private readonly delayMs: number
  private readonly driver: AnthropicDriver | null

  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
    /** Optional AnthropicDriver — when present and key set, real-mode is used. */
    driver: AnthropicDriver | null = null,
  ) {
    const raw = process.env['VISION_PM_STUB_DELAY_MS']
    this.delayMs = raw !== undefined && raw !== '' ? parseInt(raw, 10) : 1200
    this.driver = driver
  }

  /**
   * Respond to a user message in a vision intake session.
   *
   * Called fire-and-forget from the pm-stub-subscriber after a user's
   * VisionMessageSent event lands. Two paths:
   *
   * 1. Real (driver injected + ANTHROPIC_API_KEY set): AnthropicDriver.invoke
   *    with the PM vision prompt; the model decides whether to ask a follow-up,
   *    propose draft updates, or signal lock_ready.
   *
   * 2. Templated (no driver or no key): PM_SCRIPT line based on userMessageCount;
   *    skeleton draft on turn 3.
   *
   * Both paths persist a vision_messages row and emit VisionMessageSent.
   */
  async onMessage(sessionId: VisionSessionId, userMessageCount: number): Promise<void> {
    const session = await this._getSession(sessionId)
    if (!session) {
      logger.warn({ sessionId }, 'pm-stub: session not found; skipping reply')
      return
    }
    if (session.state !== 'open') {
      logger.debug({ sessionId, state: session.state }, 'pm-stub: session no longer open; skipping')
      return
    }

    // Real-mode branch: try AnthropicDriver first, fall back on any error.
    if (this.driver) {
      try {
        await this._respondViaDriver(session, sessionId, userMessageCount)
        return
      } catch (err) {
        if (err instanceof AnthropicDriverNoKeyError) {
          logger.debug(
            { sessionId },
            'pm-stub: ANTHROPIC_API_KEY unset, using templated path',
          )
        } else {
          logger.warn(
            { err, sessionId },
            'pm-stub: AnthropicDriver call failed, falling back to templated reply',
          )
        }
        // fall through to templated path below
      }
    }

    // Templated path: PM_SCRIPT line + skeleton draft on turn 3.
    await this._delay(this.delayMs + Math.floor(Math.random() * 300))

    const replyText = pmReply(userMessageCount)
    const messageId = uuidv7()
    const now = new Date().toISOString()

    const pmActor = {
      type: 'persona' as const,
      persona_id: 'pm-stub',
      session_id: session.pmPersonaSessionId ?? uuidv7(),
    }

    // Emit VisionMessageSent (pm_persona)
    const event = await this.eventStore.append({
      aggregate_id: session.visionDocumentId,
      aggregate_type: 'vision_document',
      event_type: 'VisionMessageSent',
      payload: {
        vision_session_id: sessionId,
        vision_message_id: messageId,
        author_type: 'pm_persona',
        body: replyText,
        body_tokens: Math.ceil(replyText.length / 4),
      },
      actor: pmActor,
      trace_id: uuidv7(),
      occurred_at: now,
      schema_version: 1,
    })

    // Persist vision_messages row
    await this.db.insert(visionMessages).values({
      visionMessageId: messageId,
      visionSessionId: sessionId,
      authorType: 'pm_persona',
      actor: pmActor as unknown as Record<string, unknown>,
      body: replyText,
      bodyTokens: Math.ceil(replyText.length / 4),
      eventId: event.event_id,
    })

    logger.debug(
      { sessionId, messageId, userMessageCount },
      'pm-stub: PM reply written',
    )

    // After 3 user messages, write a draft vision document so the right panel
    // has content to display.
    if (userMessageCount >= 3) {
      await this._writeDraft(sessionId, session.visionDocumentId).catch((err) => {
        logger.warn({ err, sessionId }, 'pm-stub: draft write failed (non-fatal)')
      })
    }
  }

  // --------------------------------------------------------------------------
  // _writeDraft — synthesise a minimal skeleton VisionDocumentVersion
  // --------------------------------------------------------------------------

  private async _writeDraft(
    sessionId: VisionSessionId,
    documentId: string,
  ): Promise<void> {
    // Load the current document
    const docRows = await this.db
      .select()
      .from(visionDocuments)
      .where(eq(visionDocuments.visionDocumentId, documentId))
      .limit(1)

    const doc = docRows[0]
    if (!doc) return

    // Check whether a draft version already exists — idempotency guard
    const existingDraft = await this.db
      .select()
      .from(visionVersions)
      .where(
        and(
          eq(visionVersions.visionDocumentId, documentId),
          eq(visionVersions.isLocked, 0),
        ),
      )
      .limit(1)

    if (existingDraft[0]) {
      logger.debug({ sessionId, documentId }, 'pm-stub: draft already exists; skipping')
      return
    }

    const now = new Date().toISOString()
    const content = {
      schema_version: 1 as const,
      title: doc.title,
      summary:
        'Draft summary — the PM persona is still gathering information. ' +
        'This will be fleshed out as the conversation continues.',
      goals: [
        {
          id: uuidv7(),
          text: 'Primary goal — to be refined during intake.',
          rank: 1,
        },
      ],
      non_goals: [
        {
          id: uuidv7(),
          text: 'Out-of-scope items — to be defined during intake.',
        },
      ],
      target_users: [
        {
          id: uuidv7(),
          segment: 'Primary User',
          description: 'User segment — to be identified during intake.',
          primary: true,
        },
      ],
      acceptance_criteria: [
        {
          id: uuidv7(),
          text: 'Acceptance criteria — to be confirmed during intake.',
          rank: 1,
        },
      ],
      glossary: [],
      edge_cases: [],
      open_questions: [],
      assumptions_log: [],
      metadata: {
        pm_persona_id: 'pm-stub',
        model_used: 'stub',
        intake_started_at: now,
        intake_token_total: 0,
      },
    }

    const parsed = VisionDocumentContentDraftSchema.safeParse(content)
    if (!parsed.success) {
      logger.warn({ sessionId, issues: parsed.error.issues }, 'pm-stub: draft content invalid; skipping')
      return
    }

    const versionId = uuidv7()
    const contentHash = computeContentHash(content)

    // Negative version number avoids UNIQUE constraint conflict with locked
    // versions (positive). Draft rows use -1, -2, -3 ...
    const allDraftRows = await this.db
      .select()
      .from(visionVersions)
      .where(
        and(
          eq(visionVersions.visionDocumentId, documentId),
          eq(visionVersions.isLocked, 0),
        ),
      )
    const draftNumber = -(allDraftRows.length + 1)

    const pmActor = {
      type: 'persona' as const,
      persona_id: 'pm-stub',
      session_id: sessionId,
    }

    await this.db.insert(visionVersions).values({
      visionVersionId: versionId,
      visionDocumentId: documentId,
      versionNumber: draftNumber,
      content: content as unknown as Record<string, unknown>,
      contentHash,
      changelog: 'Stub draft — auto-generated by PM intake stub after 3+ messages',
      isLocked: 0,
      draftedBy: pmActor as unknown as Record<string, unknown>,
    })

    // Emit VisionDrafted event
    const draftEvent = await this.eventStore.append({
      aggregate_id: documentId,
      aggregate_type: 'vision_document',
      event_type: 'VisionDrafted',
      payload: {
        vision_session_id: sessionId,
        vision_document_id: documentId,
        vision_version_id: versionId,
        version_number: 1, // display number (always 1 for first stub draft)
        content_hash: contentHash,
        draft_summary: 'Stub draft auto-generated by PM intake after 3 messages',
        open_questions_count: 0,
        is_locked: false,
      },
      actor: pmActor,
      trace_id: uuidv7(),
      occurred_at: now,
      schema_version: 1,
    })

    // Advance document pointer
    await this.db
      .update(visionDocuments)
      .set({
        currentVersionId: versionId,
        lastEventId: draftEvent.event_id,
      })
      .where(eq(visionDocuments.visionDocumentId, documentId))

    logger.info({ sessionId, documentId, versionId }, 'pm-stub: skeleton draft written')
  }

  // --------------------------------------------------------------------------
  // Real-mode path — invoke AnthropicDriver
  // --------------------------------------------------------------------------

  private async _respondViaDriver(
    session: { visionDocumentId: string; pmPersonaSessionId: string | null },
    sessionId: VisionSessionId,
    userMessageCount: number,
  ): Promise<void> {
    if (!this.driver) {
      throw new AnthropicDriverNoKeyError()
    }

    // 1. Load conversation history from the DB.
    const messageRows = await this.db
      .select({
        authorType: visionMessages.authorType,
        body: visionMessages.body,
      })
      .from(visionMessages)
      .where(eq(visionMessages.visionSessionId, sessionId))
      .orderBy(asc(visionMessages.postedAt))

    const history = messageRows.map((r) => ({
      author: r.authorType as 'user' | 'pm_persona',
      body: r.body,
    }))

    // 2. Load the current draft (if any).
    const draftRows = await this.db
      .select()
      .from(visionVersions)
      .where(
        and(
          eq(visionVersions.visionDocumentId, session.visionDocumentId),
          eq(visionVersions.isLocked, 0),
        ),
      )
      .orderBy(asc(visionVersions.versionNumber))
      .limit(1)

    const docRows = await this.db
      .select()
      .from(visionDocuments)
      .where(eq(visionDocuments.visionDocumentId, session.visionDocumentId))
      .limit(1)
    const doc = docRows[0]

    let draft: PMVisionContext['draft']
    if (draftRows[0]) {
      const content = draftRows[0].content as Record<string, unknown>
      const goalsArr = Array.isArray(content['goals'])
        ? (content['goals'] as Array<{ text?: string }>).map((g) => g.text ?? '').filter(Boolean)
        : undefined
      const nonGoalsArr = Array.isArray(content['non_goals'])
        ? (content['non_goals'] as Array<{ text?: string }>).map((g) => g.text ?? '').filter(Boolean)
        : undefined
      const usersArr = Array.isArray(content['target_users'])
        ? (content['target_users'] as Array<{
            segment?: string
            description?: string
            primary?: boolean
          }>).map((u) => ({
            segment: u.segment ?? '',
            description: u.description ?? '',
            primary: !!u.primary,
          }))
        : undefined
      const acsArr = Array.isArray(content['acceptance_criteria'])
        ? (content['acceptance_criteria'] as Array<{ text?: string }>)
            .map((a) => a.text ?? '')
            .filter(Boolean)
        : undefined
      const draftCtx: NonNullable<PMVisionContext['draft']> = {
        title: typeof content['title'] === 'string' ? content['title'] : doc?.title ?? '',
      }
      if (typeof content['summary'] === 'string') draftCtx.summary = content['summary']
      if (goalsArr) draftCtx.goals = goalsArr
      if (nonGoalsArr) draftCtx.non_goals = nonGoalsArr
      if (usersArr) draftCtx.target_users = usersArr
      if (acsArr) draftCtx.acceptance_criteria = acsArr
      draft = draftCtx
    }

    // 3. Build the prompts and invoke the driver.
    const ctx: PMVisionContext = {
      history,
      userMessageCount,
    }
    if (draft) ctx.draft = draft

    const systemPrompt = buildPMVisionSystemPrompt()
    const userPrompt = buildPMVisionUserPrompt(ctx)

    const driverResult = await this.driver.invoke({
      persona: 'pm',
      riskClass: 'standard',
      sessionId,
      systemPrompt,
      userPrompt,
      responseSchema: PMVisionResponseSchema,
      maxTokens: 2048,
    })

    const response = driverResult.result

    // 4. Persist the PM reply.
    await this._writePMMessageRow(session, sessionId, response.reply)

    // 5. If the model proposed draft updates, write a new draft version.
    if (response.draft_update && hasDraftFields(response.draft_update)) {
      await this._writeDraftFromUpdate(
        sessionId,
        session.visionDocumentId,
        response.draft_update,
        draft,
      ).catch((err) => {
        logger.warn(
          { err, sessionId },
          'pm-stub: real-mode draft write failed (non-fatal)',
        )
      })
    } else if (userMessageCount >= 3 && !draft) {
      // Bootstrap a skeleton on turn 3+ even if the model didn't propose updates,
      // so the UI's right panel always shows something.
      await this._writeDraft(sessionId, session.visionDocumentId).catch((err) => {
        logger.warn({ err, sessionId }, 'pm-stub: skeleton draft write failed (non-fatal)')
      })
    }

    logger.debug(
      {
        sessionId,
        userMessageCount,
        model: driverResult.model,
        costUsdMicros: driverResult.costUsdMicros,
        lockReady: response.lock_ready,
      },
      'pm-stub: real-mode reply written',
    )
  }

  // --------------------------------------------------------------------------
  // Persist a single PM message row + emit VisionMessageSent
  // --------------------------------------------------------------------------

  private async _writePMMessageRow(
    session: { pmPersonaSessionId: string | null; visionDocumentId: string },
    sessionId: VisionSessionId,
    body: string,
  ): Promise<void> {
    const messageId = uuidv7()
    const now = new Date().toISOString()
    const pmActor = {
      type: 'persona' as const,
      persona_id: 'pm',
      session_id: session.pmPersonaSessionId ?? uuidv7(),
    }

    const event = await this.eventStore.append({
      aggregate_id: session.visionDocumentId,
      aggregate_type: 'vision_document',
      event_type: 'VisionMessageSent',
      payload: {
        vision_session_id: sessionId,
        vision_message_id: messageId,
        author_type: 'pm_persona',
        body,
        body_tokens: Math.ceil(body.length / 4),
      },
      actor: pmActor,
      trace_id: uuidv7(),
      occurred_at: now,
      schema_version: 1,
    })

    await this.db.insert(visionMessages).values({
      visionMessageId: messageId,
      visionSessionId: sessionId,
      authorType: 'pm_persona',
      actor: pmActor as unknown as Record<string, unknown>,
      body,
      bodyTokens: Math.ceil(body.length / 4),
      eventId: event.event_id,
    })
  }

  // --------------------------------------------------------------------------
  // Persist a real draft generated by the LLM
  // --------------------------------------------------------------------------

  private async _writeDraftFromUpdate(
    sessionId: VisionSessionId,
    documentId: string,
    update: NonNullable<PMVisionResponse['draft_update']>,
    priorDraft: PMVisionContext['draft'],
  ): Promise<void> {
    const docRows = await this.db
      .select()
      .from(visionDocuments)
      .where(eq(visionDocuments.visionDocumentId, documentId))
      .limit(1)
    const doc = docRows[0]
    if (!doc) return

    const now = new Date().toISOString()

    // Merge update fields over the prior draft.
    const mergedTitle = update.title ?? priorDraft?.title ?? doc.title
    const mergedSummary =
      update.summary ?? priorDraft?.summary ?? 'Draft summary (in progress).'

    const goalsTexts =
      update.goals ??
      priorDraft?.goals ??
      ['Primary goal — to be refined during intake.']
    const nonGoalsTexts =
      update.non_goals ??
      priorDraft?.non_goals ??
      ['Out-of-scope items — to be defined during intake.']
    const usersInput = update.target_users ??
      priorDraft?.target_users ?? [
        {
          segment: 'Primary User',
          description: 'User segment — to be identified during intake.',
          primary: true,
        },
      ]
    const acsTexts =
      update.acceptance_criteria ??
      priorDraft?.acceptance_criteria ??
      ['Acceptance criteria — to be confirmed during intake.']

    const content = {
      schema_version: 1 as const,
      title: mergedTitle,
      summary: mergedSummary,
      goals: goalsTexts.map((text, i) => ({ id: uuidv7(), text, rank: i + 1 })),
      non_goals: nonGoalsTexts.map((text) => ({ id: uuidv7(), text })),
      target_users: usersInput.map((u) => ({
        id: uuidv7(),
        segment: u.segment,
        description: u.description,
        primary: !!u.primary,
      })),
      acceptance_criteria: acsTexts.map((text, i) => ({
        id: uuidv7(),
        text,
        rank: i + 1,
      })),
      glossary: [],
      edge_cases: [],
      open_questions: [],
      assumptions_log: [],
      metadata: {
        pm_persona_id: 'pm',
        model_used: 'anthropic-driver',
        intake_started_at: now,
        intake_token_total: 0,
      },
    }

    const parsed = VisionDocumentContentDraftSchema.safeParse(content)
    if (!parsed.success) {
      logger.warn(
        { sessionId, issues: parsed.error.issues },
        'pm-stub: real-mode draft content invalid; skipping',
      )
      return
    }

    const versionId = uuidv7()
    const contentHash = computeContentHash(content)
    const allDraftRows = await this.db
      .select()
      .from(visionVersions)
      .where(
        and(
          eq(visionVersions.visionDocumentId, documentId),
          eq(visionVersions.isLocked, 0),
        ),
      )
    const draftNumber = -(allDraftRows.length + 1)

    const pmActor = {
      type: 'persona' as const,
      persona_id: 'pm',
      session_id: sessionId,
    }

    await this.db.insert(visionVersions).values({
      visionVersionId: versionId,
      visionDocumentId: documentId,
      versionNumber: draftNumber,
      content: content as unknown as Record<string, unknown>,
      contentHash,
      changelog: 'Real-mode draft from PM AnthropicDriver invocation',
      isLocked: 0,
      draftedBy: pmActor as unknown as Record<string, unknown>,
    })

    const draftEvent = await this.eventStore.append({
      aggregate_id: documentId,
      aggregate_type: 'vision_document',
      event_type: 'VisionDrafted',
      payload: {
        vision_session_id: sessionId,
        vision_document_id: documentId,
        vision_version_id: versionId,
        version_number: 1,
        content_hash: contentHash,
        draft_summary: 'Real-mode draft from PM AnthropicDriver invocation',
        open_questions_count: 0,
        is_locked: false,
      },
      actor: pmActor,
      trace_id: uuidv7(),
      occurred_at: now,
      schema_version: 1,
    })

    await this.db
      .update(visionDocuments)
      .set({
        currentVersionId: versionId,
        lastEventId: draftEvent.event_id,
      })
      .where(eq(visionDocuments.visionDocumentId, documentId))
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  private async _getSession(sessionId: VisionSessionId) {
    const rows = await this.db
      .select()
      .from(visionSessions)
      .where(eq(visionSessions.visionSessionId, sessionId))
      .limit(1)
    return rows[0] ?? null
  }

  private _delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms))
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasDraftFields(update: NonNullable<PMVisionResponse['draft_update']>): boolean {
  return (
    update.title !== undefined ||
    update.summary !== undefined ||
    (update.goals !== undefined && update.goals.length > 0) ||
    (update.non_goals !== undefined && update.non_goals.length > 0) ||
    (update.target_users !== undefined && update.target_users.length > 0) ||
    (update.acceptance_criteria !== undefined && update.acceptance_criteria.length > 0)
  )
}
