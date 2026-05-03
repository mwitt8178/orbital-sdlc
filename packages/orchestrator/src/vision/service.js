/**
 * vision/service.ts — VisionService implementation.
 *
 * Per TRD-01 §6.1, §12, Implementation Plan §8 Task 4A.
 *
 * Responsibilities:
 *   - start(): create vision_documents + vision_sessions rows, spawn PM persona,
 *     post initial welcome to #vision-intake channel, emit VisionSessionStarted.
 *   - sendMessage(): persist user message, relay to PM persona via channel post,
 *     emit VisionMessageSent.
 *   - draft(): PM persona produces a draft snapshot (vision_versions is_locked=0);
 *     emit VisionDrafted.
 *   - lock(): validate fields, fire pre-status-transition hook, insert locked
 *     vision_versions row, advance header pointer, emit VisionLocked.
 *   - revise(): copy-on-write new version, emit VisionRevised.
 *
 * Rules:
 *   - No direct db.insert(events) — all events via EventStore.append.
 *   - PM persona spawn uses a synthetic task with persona='pm', special capability
 *     profile: channel_post on #vision-intake-{sessionId} only, no files_write.
 *   - HookEngine.fire('pre-status-transition', ...) called on lock and revise.
 */
import { uuidv7 } from 'uuidv7';
import { eq, and } from 'drizzle-orm';
import { OrbitalError } from '@orbital/types';
import { resolvePersona } from '../orchestration/persona-lookup.js';
import { tasks as taskTable } from '../db/schema/orchestration.js';
import { DEFAULT_RETRY_BUDGET, DEFAULT_TOKEN_BUDGET, DEFAULT_WALL_CLOCK_TIMEOUT_MS, } from '../orchestration/types.js';
import { logger } from '../config/logger.js';
import { visionDocuments, visionVersions, visionSessions, visionMessages, } from '../db/schema/vision.js';
import { assertLockAllowed, assertReviseAllowed, validateForLock, issueConfirmationToken, consumeConfirmationToken, computeContentHash, } from './lifecycle.js';
import { VisionDocumentContentDraftSchema } from './types.js';
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
export class DefaultVisionService {
    db;
    eventStore;
    channelsService;
    hookEngine;
    personaLoader;
    capabilityAuthority;
    routingEngine;
    installId;
    scheduler;
    constructor(db, eventStore, channelsService, hookEngine, personaLoader, capabilityAuthority, routingEngine, installId, 
    /**
     * Optional Scheduler. When present, VisionService.start() enqueues a real
     * PM-persona task so the worker actually spawns. When absent, the session
     * is opened and the channel is created but the PM persona never runs (the
     * existing PR-1 fallback behavior). Boot wires the real Scheduler in
     * production; existing unit tests construct the service without it.
     */
    scheduler) {
        this.db = db;
        this.eventStore = eventStore;
        this.channelsService = channelsService;
        this.hookEngine = hookEngine;
        this.personaLoader = personaLoader;
        this.capabilityAuthority = capabilityAuthority;
        this.routingEngine = routingEngine;
        this.installId = installId;
        this.scheduler = scheduler;
    }
    // --------------------------------------------------------------------------
    // start
    // --------------------------------------------------------------------------
    async start(params) {
        const { title, initial_prompt, actor, trace_id, justification } = params;
        const now = new Date().toISOString();
        // Check for duplicate title within install (idempotency window: 5 min per TRD-01 §8.4)
        const existing = await this.db
            .select()
            .from(visionDocuments)
            .where(and(eq(visionDocuments.installId, this.installId), eq(visionDocuments.title, title)))
            .limit(1);
        if (existing[0]) {
            // Return the existing session if within the idempotency window
            const existingDoc = existing[0];
            const createdAt = existingDoc.createdAt instanceof Date
                ? existingDoc.createdAt.getTime()
                : new Date(existingDoc.createdAt).getTime();
            if (Date.now() - createdAt < 5 * 60 * 1000) {
                // Find the latest open session
                const session = await this.db
                    .select()
                    .from(visionSessions)
                    .where(and(eq(visionSessions.visionDocumentId, existingDoc.visionDocumentId), eq(visionSessions.state, 'open')))
                    .limit(1);
                if (session[0]) {
                    return {
                        vision_document_id: existingDoc.visionDocumentId,
                        vision_session_id: session[0].visionSessionId,
                        pm_persona_request_id: uuidv7(),
                    };
                }
            }
            throw new OrbitalError('CONFLICT_DUPLICATE_VISION_TITLE', `A vision document with title '${title}' already exists in this installation.`, { title }, 'no_retry');
        }
        const documentId = uuidv7();
        const sessionId = uuidv7();
        const pmPersonaRequestId = uuidv7();
        // Event id for last_event_id seed
        const seedEventId = uuidv7();
        // Create vision_documents row
        await this.db.insert(visionDocuments).values({
            visionDocumentId: documentId,
            installId: this.installId,
            title,
            lifecycleState: 'drafting',
            currentVersionId: null,
            currentVersionNumber: 0,
            mondayItemId: null,
            createdBy: actor,
            lastEventId: seedEventId,
        });
        // Create vision_sessions row
        await this.db.insert(visionSessions).values({
            visionSessionId: sessionId,
            visionDocumentId: documentId,
            state: 'open',
            pmPersonaSessionId: null,
            pmCapabilityId: null,
            startedBy: actor,
        });
        // Look up PM persona definition by slug (loader.get expects UUID;
        // resolvePersona handles slug-to-UUID translation per TRD-03 §4.2).
        const pmPersona = await resolvePersona(this.db, this.personaLoader, 'pm').catch((err) => {
            logger.warn({ err }, 'VisionService.start: PM persona not found; proceeding without spawn');
            return null;
        });
        // Ensure #vision-intake channel exists
        const channelResult = await this.channelsService.ensureChannel('sprint', `vision-intake-${sessionId}`, {
            description: `Vision intake session ${sessionId}`,
            createdBy: { type: 'system', component: 'orchestrator' },
        });
        logger.info({ channelId: channelResult.channelId, sessionId }, 'vision_intake_channel_ensured');
        // Spawn PM persona as a synthetic task worker.
        // The "task" is the vision intake session; persona = pm.
        // Capability profile: channel_post on #vision-intake-{sessionId} only, no files_write.
        //
        // NOTE on Scheduler API (TRD-01 §12 + boot DI integration):
        // The brief specifies `scheduler.addTask({persona, task_id, capability_scopes})`,
        // but the existing Scheduler interface only exposes `addSprint(s, tasks)`. The
        // production path is to insert a real `tasks` row that the existing tick loop
        // picks up — that path issues capability + creates worktree + spawns the
        // worker through `spawn()` (see scheduler.allocateSlot). We synthesize a
        // unique sprint id for the vision intake session so the row's UUID column
        // is satisfied and the scheduler tracks it via `addSprint`.
        if (pmPersona) {
            try {
                // Issue a capability bundle scoped for vision intake only.
                // We still issue the bundle here even though the Scheduler will issue
                // its own at spawn time — this writes the audit trail of the explicit
                // Vision-side capability (TRD-01 §12.4) and seeds the session row.
                const bundle = await this.capabilityAuthority.issue({
                    install_id: this.installId,
                    persona_id: pmPersona.personaId,
                    task_id: documentId, // use documentId as synthetic task_id
                    sprint_id: documentId, // sprint id must be a uuid; reuse documentId as sentinel
                    session_id: uuidv7(),
                    scopes: {
                        files_read: [],
                        files_write: [],
                        board_read: [`ticket:vision_document:${documentId}`],
                        board_mutate: [`ticket:vision_document:${documentId}.assumptions`],
                        channel_read: [`#vision-intake-${sessionId}`],
                        channel_post: [`#vision-intake-${sessionId}`],
                        secrets: [],
                        network_egress: ['api.anthropic.com'],
                        spawn_subagent: false,
                        git_commit: [],
                        ceremony_role: [],
                    },
                    ttl_ms: 4 * 60 * 60 * 1000, // 4 hours for the intake session
                    justification,
                    actor: { type: 'system', component: 'orchestrator' },
                    trace_id,
                });
                // Update session with capability id
                await this.db
                    .update(visionSessions)
                    .set({
                    pmPersonaSessionId: bundle.bundle.session_id,
                    pmCapabilityId: bundle.bundle.capability_id,
                })
                    .where(eq(visionSessions.visionSessionId, sessionId));
                // PM persona posts initial greeting to #vision-intake channel
                await this.channelsService.post(channelResult.channelId, {
                    postType: 'status_update',
                    payload: {
                        text: `PM persona session started for vision intake: "${title}". Initial prompt received. I will begin the structured intake interview to produce a locked vision document.`,
                        vision_session_id: sessionId,
                        pm_persona_request_id: pmPersonaRequestId,
                    },
                    author: {
                        type: 'system',
                        component: 'orchestrator',
                    },
                    capabilityId: bundle.bundle.capability_id,
                    justification,
                });
                // Real Scheduler-driven spawn (closes TRD-01 §12 PM-spawn gap).
                // We insert a tasks row scoped to this synthetic sprint and ask the
                // scheduler to track the sprint. The next tick allocates a slot and
                // the spawn() call writes AgentSpawned via EventStore.
                if (this.scheduler) {
                    const pmTaskId = uuidv7();
                    try {
                        await this.db.insert(taskTable).values({
                            taskId: pmTaskId,
                            sprintId: documentId,
                            ticketId: `VISION-${documentId.slice(0, 8)}`,
                            title: `PM intake: ${title}`,
                            description: `Vision intake session ${sessionId} for document ${documentId}.`,
                            acceptanceCriteria: [],
                            personaId: pmPersona.personaId,
                            riskClass: 'standard',
                            state: 'ready',
                            attemptCount: 0,
                            retryBudget: DEFAULT_RETRY_BUDGET,
                            wallClockTimeoutMs: DEFAULT_WALL_CLOCK_TIMEOUT_MS,
                            tokenBudget: DEFAULT_TOKEN_BUDGET,
                            tokensConsumed: 0,
                            declaredWritePaths: [],
                            createdByEventId: uuidv7(),
                        });
                        this.scheduler.addSprint({ sprintId: documentId, priority: 3 }, []);
                        void this.scheduler.tick().catch((err) => {
                            logger.warn({ err, sessionId, documentId }, 'VisionService.start: immediate scheduler.tick failed; periodic loop will retry');
                        });
                        logger.info({ sessionId, pmTaskId, documentId }, 'vision_pm_task_enqueued');
                    }
                    catch (err) {
                        logger.warn({ err, sessionId, documentId }, 'VisionService.start: failed to enqueue PM task — session open, capability issued, but PM persona will not run');
                    }
                }
                else {
                    logger.warn({ sessionId }, 'VisionService.start: no Scheduler injected — PM persona session opened but no worker will spawn (boot DI gap)');
                }
                logger.info({ sessionId, capabilityId: bundle.bundle.capability_id, personaId: pmPersona.personaId }, 'vision_pm_persona_spawned');
            }
            catch (err) {
                logger.warn({ err, sessionId }, 'VisionService.start: PM persona spawn failed; session open without PM');
            }
        }
        // Emit VisionSessionStarted event
        const event = await this.eventStore.append({
            aggregate_id: documentId,
            aggregate_type: 'vision_document',
            event_type: 'VisionSessionStarted',
            payload: {
                vision_session_id: sessionId,
                vision_document_id: documentId,
                initial_prompt,
                pm_persona_request_id: pmPersonaRequestId,
                expected_required_capabilities: [
                    `board_read:ticket:vision_document:${documentId}`,
                    `channel_post:#vision-intake-${sessionId}`,
                ],
            },
            actor,
            trace_id,
            occurred_at: now,
            schema_version: 1,
        });
        // Update lastEventId
        await this.db
            .update(visionDocuments)
            .set({ lastEventId: event.event_id })
            .where(eq(visionDocuments.visionDocumentId, documentId));
        logger.info({ documentId, sessionId, title }, 'vision_session_started');
        // UX FIX: persist `initial_prompt` as the first user message so the PM
        // stub subscriber fires immediately. The user shouldn't have to retype
        // their prompt — they already gave it on the create form. This makes
        // the chat have a real starting context instead of an empty "type your
        // first message below" placeholder.
        if (initial_prompt && initial_prompt.trim().length > 0) {
            try {
                await this.sendMessage(sessionId, initial_prompt.trim(), actor, trace_id);
            }
            catch (err) {
                logger.warn({ err, sessionId }, 'VisionService.start: auto-send of initial_prompt failed; session open without first message');
            }
        }
        return { vision_document_id: documentId, vision_session_id: sessionId, pm_persona_request_id: pmPersonaRequestId };
    }
    // --------------------------------------------------------------------------
    // sendMessage
    // --------------------------------------------------------------------------
    async sendMessage(sessionId, message, actor, traceId) {
        const now = new Date().toISOString();
        // Validate session state
        const sessionRows = await this.db
            .select()
            .from(visionSessions)
            .where(eq(visionSessions.visionSessionId, sessionId))
            .limit(1);
        const session = sessionRows[0];
        if (!session) {
            throw new OrbitalError('NOT_FOUND_VISION_SESSION', `Vision session ${sessionId} not found`, {}, 'no_retry');
        }
        if (session.state !== 'open' && session.state !== 'closed_drafted') {
            throw new OrbitalError('CONFLICT_SESSION_CLOSED', `Vision session ${sessionId} is in state '${session.state}' and cannot accept messages.`, { state: session.state }, 'no_retry');
        }
        const messageId = uuidv7();
        // Emit VisionMessageSent event first to get the event_id
        const event = await this.eventStore.append({
            aggregate_id: session.visionDocumentId,
            aggregate_type: 'vision_document',
            event_type: 'VisionMessageSent',
            payload: {
                vision_session_id: sessionId,
                vision_message_id: messageId,
                author_type: 'user',
                body: message,
                body_tokens: Math.ceil(message.length / 4),
            },
            actor,
            trace_id: traceId,
            occurred_at: now,
            schema_version: 1,
        });
        // Persist message row
        await this.db.insert(visionMessages).values({
            visionMessageId: messageId,
            visionSessionId: sessionId,
            authorType: 'user',
            actor: actor,
            body: message,
            bodyTokens: Math.ceil(message.length / 4),
            eventId: event.event_id,
        });
        // Increment exchange_count; re-open if closed_drafted
        await this.db
            .update(visionSessions)
            .set({
            exchangeCount: (session.exchangeCount ?? 0) + 1,
            state: 'open',
        })
            .where(eq(visionSessions.visionSessionId, sessionId));
        // Post to vision-intake channel so the PM persona (when implemented) can read it
        const channelName = `#vision-intake-${sessionId}`;
        const channel = await this.channelsService.getByName?.(channelName).catch(() => null);
        if (channel) {
            await this.channelsService.post(channel.channelId, {
                postType: 'user_guidance',
                payload: { text: message, vision_session_id: sessionId, vision_message_id: messageId },
                author: actor,
                justification: 'User message in vision intake session',
            }).catch((err) => {
                logger.warn({ err, sessionId }, 'VisionService.sendMessage: failed to post to channel');
            });
        }
        logger.debug({ sessionId, messageId }, 'vision_message_sent');
        return {
            vision_message_id: messageId,
            vision_session_id: sessionId,
            author_type: 'user',
            body: message,
            posted_at: now,
        };
    }
    // --------------------------------------------------------------------------
    // draft
    // --------------------------------------------------------------------------
    async draft(sessionId, content, draftSummary, actor, traceId) {
        const now = new Date().toISOString();
        const sessionRows = await this.db
            .select()
            .from(visionSessions)
            .where(eq(visionSessions.visionSessionId, sessionId))
            .limit(1);
        const session = sessionRows[0];
        if (!session) {
            throw new OrbitalError('NOT_FOUND_VISION_SESSION', `Vision session ${sessionId} not found`, {}, 'no_retry');
        }
        // Validate partial content shape
        const parseResult = VisionDocumentContentDraftSchema.safeParse(content);
        if (!parseResult.success) {
            throw new OrbitalError('VALIDATION_TYPE_MISMATCH', `Draft content validation failed: ${parseResult.error.message}`, { issues: parseResult.error.issues }, 'no_retry');
        }
        const docRows = await this.db
            .select()
            .from(visionDocuments)
            .where(eq(visionDocuments.visionDocumentId, session.visionDocumentId))
            .limit(1);
        const doc = docRows[0];
        if (!doc) {
            throw new OrbitalError('NOT_FOUND_VISION_DOCUMENT', `Vision document ${session.visionDocumentId} not found`, {}, 'no_retry');
        }
        // Draft snapshots use version_number = 0 (reserved sentinel for in-flight drafts).
        // Only locked versions consume positive version numbers (1, 2, 3...).
        // This avoids unique-constraint conflicts on (vision_document_id, version_number).
        const versionId = uuidv7();
        const contentHash = computeContentHash(content);
        const openQCount = Array.isArray(content['open_questions'])
            ? content['open_questions'].length
            : 0;
        // If a prior draft row (version_number=0) exists, we need to give this new one a
        // unique sub-key. We use a negative offset based on existing draft count.
        // Simplest: encode draft order as 0, -1, -2, ... (negative, never conflicts with locked).
        // But SQL constraints require positive ints... So instead: store draft row with a unique
        // negative version_number derived from the session id hash (deterministic but unique enough).
        // Actually the simplest correct approach: draft snapshots don't go into vision_versions
        // with a UNIQUE version_number constraint at all. We use a UUID-based pseudo-number
        // by taking the first 8 hex chars of the versionId as an int (always positive but unique).
        // But that's complex. Best approach: remove the UNIQUE constraint issue by assigning
        // draft version numbers as negative sequential integers, starting at -1.
        // Draft snapshots use negative version numbers to avoid UNIQUE constraint conflicts
        // with locked versions (which use positive numbers 1, 2, 3...).
        // The display version number for the draft is the sequential draft count (1, 2, ...).
        const existingDraftRows = await this.db
            .select()
            .from(visionVersions)
            .where(and(eq(visionVersions.visionDocumentId, session.visionDocumentId), eq(visionVersions.isLocked, 0)));
        const displayDraftNumber = existingDraftRows.length + 1; // 1, 2, 3, ...
        const draftVersionNumber = -displayDraftNumber; // -1, -2, -3, ... (stored in DB)
        // Insert draft snapshot (is_locked = 0, negative version_number for uniqueness)
        await this.db.insert(visionVersions).values({
            visionVersionId: versionId,
            visionDocumentId: session.visionDocumentId,
            versionNumber: draftVersionNumber,
            content: content,
            contentHash,
            changelog: draftSummary,
            previousVersionId: doc.currentVersionId ?? undefined,
            isLocked: 0,
            draftedBy: actor,
        });
        // Advance document pointer — currentVersionNumber stays 0 (no locked version yet)
        const event = await this.eventStore.append({
            aggregate_id: session.visionDocumentId,
            aggregate_type: 'vision_document',
            event_type: 'VisionDrafted',
            payload: {
                vision_session_id: sessionId,
                vision_document_id: session.visionDocumentId,
                vision_version_id: versionId,
                version_number: displayDraftNumber,
                content_hash: contentHash,
                draft_summary: draftSummary,
                open_questions_count: openQCount,
                is_locked: false,
            },
            actor,
            trace_id: traceId,
            occurred_at: now,
            schema_version: 1,
        });
        await this.db
            .update(visionDocuments)
            .set({
            currentVersionId: versionId,
            // currentVersionNumber stays 0 until lock; draft snapshots don't advance it
            lastEventId: event.event_id,
        })
            .where(eq(visionDocuments.visionDocumentId, session.visionDocumentId));
        // Update session state to closed_drafted
        await this.db
            .update(visionSessions)
            .set({ state: 'closed_drafted' })
            .where(eq(visionSessions.visionSessionId, sessionId));
        logger.info({ sessionId, versionId, versionNumber: displayDraftNumber }, 'vision_drafted');
        return {
            vision_version_id: versionId,
            vision_document_id: session.visionDocumentId,
            version_number: displayDraftNumber,
            content: content,
            content_hash: contentHash,
            changelog: draftSummary,
            is_locked: false,
            locked_at: null,
            drafted_at: now,
        };
    }
    // --------------------------------------------------------------------------
    // reviewDraft
    // --------------------------------------------------------------------------
    async reviewDraft(documentId) {
        const docRows = await this.db
            .select()
            .from(visionDocuments)
            .where(eq(visionDocuments.visionDocumentId, documentId))
            .limit(1);
        const doc = docRows[0];
        if (!doc) {
            throw new OrbitalError('NOT_FOUND_VISION_DOCUMENT', `Vision document ${documentId} not found`, {}, 'no_retry');
        }
        let currentVersion = null;
        let validationResult = { missing_fields: [], blocking_open_questions: [] };
        if (doc.currentVersionId) {
            const vRows = await this.db
                .select()
                .from(visionVersions)
                .where(eq(visionVersions.visionVersionId, doc.currentVersionId))
                .limit(1);
            const v = vRows[0];
            if (v) {
                currentVersion = {
                    vision_version_id: v.visionVersionId,
                    vision_document_id: v.visionDocumentId,
                    version_number: v.versionNumber,
                    content: v.content,
                    content_hash: v.contentHash,
                    changelog: v.changelog,
                    is_locked: v.isLocked === 1,
                    locked_at: v.lockedAt ? (v.lockedAt instanceof Date ? v.lockedAt.toISOString() : String(v.lockedAt)) : null,
                    drafted_at: v.draftedAt instanceof Date ? v.draftedAt.toISOString() : String(v.draftedAt),
                };
                validationResult = validateForLock(v.content, { no_edge_cases: false });
            }
        }
        const token = issueConfirmationToken(documentId);
        const ready = validationResult.missing_fields.length === 0 && validationResult.blocking_open_questions.length === 0;
        return {
            vision_document_id: documentId,
            current_version: currentVersion,
            blocking_open_questions: validationResult.blocking_open_questions,
            missing_required_fields: validationResult.missing_fields,
            confirmation_token: token,
            ready_to_lock: ready,
        };
    }
    // --------------------------------------------------------------------------
    // lock
    // --------------------------------------------------------------------------
    async lock(params) {
        const { documentId, confirmationToken, changelog, attestation, actor, traceId, justification } = params;
        const now = new Date().toISOString();
        // FR-1.3: must be user actor
        assertLockAllowed('drafting', actor.type); // will re-check against DB state below
        // Consume confirmation token (validates TTL + single-use)
        consumeConfirmationToken(confirmationToken, documentId);
        // Fetch current document
        const docRows = await this.db
            .select()
            .from(visionDocuments)
            .where(eq(visionDocuments.visionDocumentId, documentId))
            .limit(1);
        const doc = docRows[0];
        if (!doc) {
            throw new OrbitalError('NOT_FOUND_VISION_DOCUMENT', `Vision document ${documentId} not found`, {}, 'no_retry');
        }
        // Re-check state from DB
        assertLockAllowed(doc.lifecycleState, actor.type);
        if (!doc.currentVersionId) {
            throw new OrbitalError('CONFLICT_NO_DRAFT_VERSION', 'No draft version exists to lock.', {}, 'no_retry');
        }
        // Fetch current draft version
        const vRows = await this.db
            .select()
            .from(visionVersions)
            .where(eq(visionVersions.visionVersionId, doc.currentVersionId))
            .limit(1);
        const currentVersion = vRows[0];
        if (!currentVersion) {
            throw new OrbitalError('NOT_FOUND_VISION_VERSION', `Version ${doc.currentVersionId} not found`, {}, 'no_retry');
        }
        // Validate required fields (FR-1.7)
        const validation = validateForLock(currentVersion.content, attestation);
        if (!validation.ready) {
            // Emit VisionLockRejected
            await this.eventStore.append({
                aggregate_id: documentId,
                aggregate_type: 'vision_document',
                event_type: 'VisionLockRejected',
                payload: {
                    vision_document_id: documentId,
                    attempted_version_id: doc.currentVersionId,
                    rejecting_party: 'validator',
                    error_code: validation.missing_fields.length > 0
                        ? 'VALIDATION_REQUIRED_FIELD_MISSING'
                        : 'CONFLICT_OPEN_QUESTIONS_BLOCK_LOCK',
                    missing_fields: validation.missing_fields,
                    blocking_open_questions: validation.blocking_open_questions,
                },
                actor,
                trace_id: traceId,
                occurred_at: now,
                schema_version: 1,
            }).catch((err) => logger.error({ err }, 'VisionService.lock: failed to emit VisionLockRejected'));
            if (validation.missing_fields.length > 0) {
                throw new OrbitalError('VALIDATION_REQUIRED_FIELD_MISSING', `Lock rejected: missing required fields: ${validation.missing_fields.join(', ')}`, { missing_fields: validation.missing_fields }, 'no_retry');
            }
            throw new OrbitalError('CONFLICT_OPEN_QUESTIONS_BLOCK_LOCK', `Lock rejected: ${validation.blocking_open_questions.length} blocking open question(s) unresolved.`, { blocking_open_questions: validation.blocking_open_questions }, 'escalate_to_human');
        }
        // Fire pre-status-transition hook (TRD-09 integration)
        const hookDecision = await this.hookEngine.fire('pre-status-transition', {
            aggregate_type: 'vision_document',
            aggregate_id: documentId,
            from_state: 'drafting',
            to_state: 'locked',
            content: currentVersion.content,
            actor,
        }, {
            trace_id: traceId,
            actor,
            capability_id: undefined,
        }, 'pre');
        if (!hookDecision.allow) {
            // Emit VisionLockRejected
            await this.eventStore.append({
                aggregate_id: documentId,
                aggregate_type: 'vision_document',
                event_type: 'VisionLockRejected',
                payload: {
                    vision_document_id: documentId,
                    attempted_version_id: doc.currentVersionId,
                    rejecting_party: 'hook_engine',
                    error_code: 'HOOK_REJECTED_PRE_LOCK',
                    missing_fields: [],
                    blocking_open_questions: [],
                    hook_id: hookDecision.hook_id,
                    hook_message: hookDecision.reason,
                },
                actor,
                trace_id: traceId,
                occurred_at: now,
                schema_version: 1,
            }).catch((err) => logger.error({ err }, 'VisionService.lock: failed to emit VisionLockRejected (hook)'));
            throw new OrbitalError('HOOK_REJECTED_PRE_LOCK', `Lock rejected by hook: ${hookDecision.reason}`, { hook_id: hookDecision.hook_id }, 'escalate_to_human');
        }
        // Insert locked version row (is_locked = 1).
        // The prior draft row remains as-is (append-only). The new locked row is a
        // fresh row with the same content, referencing the draft as previousVersionId.
        // Locked versions use positive sequential numbers: 1, 2, 3, ...
        // (draft rows use negative numbers to avoid UNIQUE constraint conflicts)
        const lockedVersionId = uuidv7();
        const lockedVersionNumber = (doc.currentVersionNumber ?? 0) + 1;
        const contentHash = computeContentHash(currentVersion.content);
        // Emit VisionLocked event
        const lockEvent = await this.eventStore.append({
            aggregate_id: documentId,
            aggregate_type: 'vision_document',
            event_type: 'VisionLocked',
            payload: {
                vision_document_id: documentId,
                vision_version_id: lockedVersionId,
                version_number: lockedVersionNumber,
                content_hash: contentHash,
                locked_by: actor,
                monday_item_id: undefined,
                changelog,
                attestation: {
                    no_edge_cases: attestation.no_edge_cases,
                    confirmation_token: '[consumed]',
                },
            },
            actor,
            trace_id: traceId,
            occurred_at: now,
            schema_version: 1,
        });
        // Insert locked version — is_locked = 1, references draft as previousVersionId
        await this.db.insert(visionVersions).values({
            visionVersionId: lockedVersionId,
            visionDocumentId: documentId,
            versionNumber: lockedVersionNumber,
            content: currentVersion.content,
            contentHash,
            changelog,
            previousVersionId: currentVersion.visionVersionId,
            isLocked: 1,
            lockedAt: new Date(now),
            lockedBy: actor,
            lockEventId: lockEvent.event_id,
            draftedBy: currentVersion.draftedBy,
        });
        // Advance header pointer + transition lifecycle to 'locked'.
        // OCC: compare-and-swap on current_version_number to detect concurrent writes.
        // If another lock() or revise() committed between our SELECT and this UPDATE
        // the WHERE clause will match 0 rows and we surface a conflict error.
        const updatedRows = await this.db
            .update(visionDocuments)
            .set({
            lifecycleState: 'locked',
            currentVersionId: lockedVersionId,
            currentVersionNumber: lockedVersionNumber,
            lastEventId: lockEvent.event_id,
        })
            .where(and(eq(visionDocuments.visionDocumentId, documentId), eq(visionDocuments.currentVersionNumber, doc.currentVersionNumber), eq(visionDocuments.lastEventId, doc.lastEventId)))
            .returning({ id: visionDocuments.visionDocumentId });
        if (updatedRows.length === 0) {
            throw new OrbitalError('CONFLICT_OPTIMISTIC_LOCK_FAILED', `Concurrent modification detected: vision document ${documentId} was modified during lock. Retry the operation.`, { document_id: documentId, expected_version: doc.currentVersionNumber }, 'retry_now');
        }
        // Close any open sessions
        await this.db
            .update(visionSessions)
            .set({ state: 'closed_locked', closedAt: new Date(now) })
            .where(and(eq(visionSessions.visionDocumentId, documentId), eq(visionSessions.state, 'open')));
        logger.info({ documentId, lockedVersionId, versionNumber: lockedVersionNumber }, 'vision_locked');
        return {
            vision_version_id: lockedVersionId,
            vision_document_id: documentId,
            version_number: lockedVersionNumber,
            content: currentVersion.content,
            content_hash: contentHash,
            changelog,
            is_locked: true,
            locked_at: now,
            drafted_at: currentVersion.draftedAt instanceof Date
                ? currentVersion.draftedAt.toISOString()
                : String(currentVersion.draftedAt),
        };
    }
    // --------------------------------------------------------------------------
    // revise
    // --------------------------------------------------------------------------
    async revise(params) {
        const { documentId, baseVersionId, delta, changelog, reason, actor, traceId } = params;
        const now = new Date().toISOString();
        assertReviseAllowed('locked', actor.type); // optimistic check; re-validated below
        const docRows = await this.db
            .select()
            .from(visionDocuments)
            .where(eq(visionDocuments.visionDocumentId, documentId))
            .limit(1);
        const doc = docRows[0];
        if (!doc) {
            throw new OrbitalError('NOT_FOUND_VISION_DOCUMENT', `Vision document ${documentId} not found`, {}, 'no_retry');
        }
        // Validate state from DB
        assertReviseAllowed(doc.lifecycleState, actor.type);
        // Optimistic concurrency: base_version_id must equal current_version_id
        if (doc.currentVersionId !== baseVersionId) {
            throw new OrbitalError('CONFLICT_VERSION_STALE', `base_version_id ${baseVersionId} is no longer current (current is ${doc.currentVersionId}).`, { expected: baseVersionId, actual: doc.currentVersionId }, 'retry_now');
        }
        // Fetch current version
        const vRows = await this.db
            .select()
            .from(visionVersions)
            .where(eq(visionVersions.visionVersionId, baseVersionId))
            .limit(1);
        const baseVersion = vRows[0];
        if (!baseVersion) {
            throw new OrbitalError('NOT_FOUND_VISION_VERSION', `Version ${baseVersionId} not found`, {}, 'no_retry');
        }
        // Apply JSON Patch delta (RFC-6902)
        let newContent;
        try {
            newContent = applyJsonPatch(baseVersion.content, delta);
        }
        catch (err) {
            throw new OrbitalError('VALIDATION_INVALID_JSON_PATCH', `JSON Patch application failed: ${err.message}`, {}, 'no_retry');
        }
        // Validate revised content has required fields
        const validation = validateForLock(newContent, { no_edge_cases: true });
        if (!validation.ready) {
            throw new OrbitalError('VALIDATION_REQUIRED_FIELD_MISSING', `Revised content missing required fields: ${validation.missing_fields.join(', ')}`, { missing_fields: validation.missing_fields }, 'no_retry');
        }
        // Fire pre-status-transition hook
        const hookDecision = await this.hookEngine.fire('pre-status-transition', {
            aggregate_type: 'vision_document',
            aggregate_id: documentId,
            from_state: doc.lifecycleState,
            to_state: 'revised',
            content: newContent,
            actor,
        }, { trace_id: traceId, actor, capability_id: undefined }, 'pre');
        if (!hookDecision.allow) {
            throw new OrbitalError('HOOK_REJECTED_PRE_LOCK', `Revise rejected by hook: ${hookDecision.reason}`, { hook_id: hookDecision.hook_id }, 'escalate_to_human');
        }
        const newVersionId = uuidv7();
        const newVersionNumber = (doc.currentVersionNumber ?? 0) + 1;
        const contentHash = computeContentHash(newContent);
        // Emit VisionRevised
        const reviseEvent = await this.eventStore.append({
            aggregate_id: documentId,
            aggregate_type: 'vision_document',
            event_type: 'VisionRevised',
            payload: {
                vision_document_id: documentId,
                prior_version_id: baseVersionId,
                prior_version_number: baseVersion.versionNumber,
                new_version_id: newVersionId,
                new_version_number: newVersionNumber,
                delta,
                changelog,
                revised_by: actor,
                reason,
            },
            actor,
            trace_id: traceId,
            occurred_at: now,
            schema_version: 1,
        });
        // Insert new version row (is_locked = 1 per TRD-01 §5.6 "creates new version").
        // A duplicate key on (visionDocumentId, versionNumber) means a concurrent revise()
        // already claimed this version_number — treat as an OCC conflict.
        try {
            await this.db.insert(visionVersions).values({
                visionVersionId: newVersionId,
                visionDocumentId: documentId,
                versionNumber: newVersionNumber,
                content: newContent,
                contentHash,
                changelog,
                deltaFromPrevious: delta,
                previousVersionId: baseVersionId,
                isLocked: 1,
                lockedAt: new Date(now),
                lockedBy: actor,
                lockEventId: reviseEvent.event_id,
                draftedBy: actor,
            });
        }
        catch (insertErr) {
            if (insertErr.code === '23505') {
                throw new OrbitalError('CONFLICT_OPTIMISTIC_LOCK_FAILED', `Concurrent revision detected: version_number ${newVersionNumber} for document ${documentId} was already claimed. Retry with the latest base_version_id.`, { vision_document_id: documentId, version_number: newVersionNumber }, 'retry_with_backoff');
            }
            throw insertErr;
        }
        // Advance header pointer to 'revised' state; prior locked version preserved.
        // OCC: compare-and-swap on current_version_number to detect concurrent writes.
        const revisedRows = await this.db
            .update(visionDocuments)
            .set({
            lifecycleState: 'revised',
            currentVersionId: newVersionId,
            currentVersionNumber: newVersionNumber,
            lastEventId: reviseEvent.event_id,
        })
            .where(and(eq(visionDocuments.visionDocumentId, documentId), eq(visionDocuments.currentVersionNumber, doc.currentVersionNumber), eq(visionDocuments.lastEventId, doc.lastEventId)))
            .returning({ id: visionDocuments.visionDocumentId });
        if (revisedRows.length === 0) {
            throw new OrbitalError('CONFLICT_OPTIMISTIC_LOCK_FAILED', `Concurrent modification detected: vision document ${documentId} was modified during revise. Retry with the latest base_version_id.`, { document_id: documentId, expected_version: doc.currentVersionNumber }, 'retry_now');
        }
        logger.info({ documentId, newVersionId, newVersionNumber, priorVersionId: baseVersionId }, 'vision_revised');
        return {
            vision_version_id: newVersionId,
            vision_document_id: documentId,
            version_number: newVersionNumber,
            content: newContent,
            content_hash: contentHash,
            changelog,
            is_locked: true,
            locked_at: now,
            drafted_at: now,
        };
    }
    // --------------------------------------------------------------------------
    // getDocument
    // --------------------------------------------------------------------------
    async getDocument(documentId) {
        const rows = await this.db
            .select()
            .from(visionDocuments)
            .where(eq(visionDocuments.visionDocumentId, documentId))
            .limit(1);
        const row = rows[0];
        if (!row) {
            throw new OrbitalError('NOT_FOUND_VISION_DOCUMENT', `Vision document ${documentId} not found`, {}, 'no_retry');
        }
        return {
            vision_document_id: row.visionDocumentId,
            install_id: row.installId,
            title: row.title,
            lifecycle_state: row.lifecycleState,
            current_version_id: row.currentVersionId ?? null,
            current_version_number: row.currentVersionNumber,
            monday_item_id: row.mondayItemId ?? null,
            created_at: row.createdAt instanceof Date ? row.createdAt.toISOString() : String(row.createdAt),
        };
    }
    // --------------------------------------------------------------------------
    // getVersion
    // --------------------------------------------------------------------------
    async getVersion(documentId, versionNumber) {
        if (versionNumber !== undefined) {
            const rows = await this.db
                .select()
                .from(visionVersions)
                .where(and(eq(visionVersions.visionDocumentId, documentId), eq(visionVersions.versionNumber, versionNumber)))
                .limit(1);
            const v = rows[0];
            if (!v)
                return null;
            return this._mapVersion(v);
        }
        // Return current version
        const docRows = await this.db
            .select()
            .from(visionDocuments)
            .where(eq(visionDocuments.visionDocumentId, documentId))
            .limit(1);
        const doc = docRows[0];
        if (!doc || !doc.currentVersionId)
            return null;
        const vRows = await this.db
            .select()
            .from(visionVersions)
            .where(eq(visionVersions.visionVersionId, doc.currentVersionId))
            .limit(1);
        return vRows[0] ? this._mapVersion(vRows[0]) : null;
    }
    // --------------------------------------------------------------------------
    // listVersions
    // --------------------------------------------------------------------------
    async listVersions(documentId, _after, limit = 20) {
        const rows = await this.db
            .select()
            .from(visionVersions)
            .where(eq(visionVersions.visionDocumentId, documentId))
            .limit(limit);
        return rows.map((v) => this._mapVersion(v));
    }
    // --------------------------------------------------------------------------
    // listMessages
    // --------------------------------------------------------------------------
    async listMessages(sessionId, limit = 200) {
        const rows = await this.db
            .select()
            .from(visionMessages)
            .where(eq(visionMessages.visionSessionId, sessionId))
            .limit(limit);
        return rows.map((row) => ({
            vision_message_id: row.visionMessageId,
            vision_session_id: row.visionSessionId,
            author_type: row.authorType,
            body: row.body,
            posted_at: row.postedAt instanceof Date ? row.postedAt.toISOString() : String(row.postedAt),
        }));
    }
    // --------------------------------------------------------------------------
    // Private helpers
    // --------------------------------------------------------------------------
    _mapVersion(v) {
        return {
            vision_version_id: v.visionVersionId,
            vision_document_id: v.visionDocumentId,
            version_number: v.versionNumber,
            content: v.content,
            content_hash: v.contentHash,
            changelog: v.changelog,
            is_locked: v.isLocked === 1,
            locked_at: v.lockedAt
                ? (v.lockedAt instanceof Date ? v.lockedAt.toISOString() : String(v.lockedAt))
                : null,
            drafted_at: v.draftedAt instanceof Date ? v.draftedAt.toISOString() : String(v.draftedAt),
        };
    }
}
// ---------------------------------------------------------------------------
// JSON Patch application (RFC-6902 subset: add, replace, remove)
// ---------------------------------------------------------------------------
function applyJsonPatch(doc, patch) {
    // Deep clone to avoid mutating the original
    const result = JSON.parse(JSON.stringify(doc));
    for (const op of patch) {
        const operation = op['op'];
        const path = op['path'];
        const value = op['value'];
        if (!path || !path.startsWith('/')) {
            throw new Error(`Invalid JSON Patch path: ${path}`);
        }
        const parts = path.split('/').slice(1).map((p) => p.replace(/~1/g, '/').replace(/~0/g, '~'));
        if (operation === 'replace' || operation === 'add') {
            setNestedValue(result, parts, value);
        }
        else if (operation === 'remove') {
            removeNestedValue(result, parts);
        }
        else {
            throw new Error(`Unsupported JSON Patch operation: ${operation}`);
        }
    }
    return result;
}
function setNestedValue(obj, path, value) {
    if (path.length === 1) {
        obj[path[0]] = value;
        return;
    }
    const key = path[0];
    if (!(key in obj) || typeof obj[key] !== 'object') {
        obj[key] = {};
    }
    setNestedValue(obj[key], path.slice(1), value);
}
function removeNestedValue(obj, path) {
    if (path.length === 1) {
        delete obj[path[0]];
        return;
    }
    const key = path[0];
    if (key in obj && typeof obj[key] === 'object') {
        removeNestedValue(obj[key], path.slice(1));
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createVisionService(db, eventStore, channelsService, hookEngine, personaLoader, capabilityAuthority, routingEngine, installId, scheduler) {
    return new DefaultVisionService(db, eventStore, channelsService, hookEngine, personaLoader, capabilityAuthority, routingEngine, installId, scheduler);
}
//# sourceMappingURL=service.js.map