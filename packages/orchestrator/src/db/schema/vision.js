/**
 * vision.ts — Drizzle schema for the vision intake module.
 *
 * Per TRD-01 §4: seven tables under the vision domain.
 * Tables: vision_documents, vision_versions, vision_sessions, vision_messages,
 *         vision_questions, vision_answers, vision_assumptions.
 *
 * append-only enforcement on vision_versions is handled by SQL triggers in
 * migration 0009_vision.sql — not by Drizzle (Drizzle cannot emit triggers).
 */
import { pgTable, pgEnum, uuid, text, integer, jsonb, timestamp, index, uniqueIndex, } from 'drizzle-orm/pg-core';
// ---------------------------------------------------------------------------
// Enums
// ---------------------------------------------------------------------------
export const visionLifecycleEnum = pgEnum('vision_lifecycle', [
    'drafting',
    'locked',
    'revised',
    'abandoned',
]);
export const visionSessionStateEnum = pgEnum('vision_session_state', [
    'open',
    'closed_drafted',
    'closed_locked',
    'abandoned',
    'failed',
]);
export const visionMessageAuthorEnum = pgEnum('vision_message_author', ['user', 'pm_persona']);
export const visionQuestionStatusEnum = pgEnum('vision_question_status', [
    'asked',
    'answered',
    'deferred',
    'withdrawn',
]);
export const visionAssumptionConfidenceEnum = pgEnum('vision_assumption_confidence', [
    'low',
    'medium',
    'high',
]);
// ---------------------------------------------------------------------------
// vision_documents — mutable header; content lives in vision_versions
// ---------------------------------------------------------------------------
export const visionDocuments = pgTable('vision_documents', {
    visionDocumentId: uuid('vision_document_id').primaryKey(),
    installId: uuid('install_id').notNull(),
    title: text('title').notNull(),
    lifecycleState: visionLifecycleEnum('lifecycle_state').notNull().default('drafting'),
    currentVersionId: uuid('current_version_id'),
    currentVersionNumber: integer('current_version_number').notNull().default(0),
    mondayItemId: text('monday_item_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: jsonb('created_by').notNull(), // ActorSchema (user)
    lastEventId: uuid('last_event_id').notNull(),
}, (t) => ({
    installIdx: index('vd_install_idx').on(t.installId),
    titleUniqPerInstall: uniqueIndex('vd_title_uniq').on(t.installId, t.title),
}));
// ---------------------------------------------------------------------------
// vision_versions — append-only; Postgres trigger blocks UPDATE/DELETE
// ---------------------------------------------------------------------------
export const visionVersions = pgTable('vision_versions', {
    visionVersionId: uuid('vision_version_id').primaryKey(),
    visionDocumentId: uuid('vision_document_id').notNull(),
    versionNumber: integer('version_number').notNull(),
    content: jsonb('content').notNull(), // VisionDocumentContent
    contentHash: text('content_hash').notNull(), // sha256(canonical_json(content))
    changelog: text('changelog').notNull(),
    deltaFromPrevious: jsonb('delta_from_previous'),
    previousVersionId: uuid('previous_version_id'),
    isLocked: integer('is_locked').notNull().default(0), // 0=draft, 1=locked
    lockedAt: timestamp('locked_at', { withTimezone: true }),
    lockedBy: jsonb('locked_by'), // ActorSchema (user); null for draft snapshots
    lockEventId: uuid('lock_event_id'),
    draftedAt: timestamp('drafted_at', { withTimezone: true }).notNull().defaultNow(),
    draftedBy: jsonb('drafted_by').notNull(), // ActorSchema (PM persona)
    schemaVersion: integer('schema_version').notNull().default(1),
}, (t) => ({
    vdNumberUniq: uniqueIndex('vv_vd_version_uniq').on(t.visionDocumentId, t.versionNumber),
    contentHashIdx: index('vv_content_hash_idx').on(t.contentHash),
    lockedIdx: index('vv_locked_idx').on(t.visionDocumentId, t.isLocked),
}));
// ---------------------------------------------------------------------------
// vision_sessions
// ---------------------------------------------------------------------------
export const visionSessions = pgTable('vision_sessions', {
    visionSessionId: uuid('vision_session_id').primaryKey(),
    visionDocumentId: uuid('vision_document_id').notNull(),
    state: visionSessionStateEnum('state').notNull().default('open'),
    pmPersonaSessionId: uuid('pm_persona_session_id'),
    pmCapabilityId: uuid('pm_capability_id'),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    exchangeCount: integer('exchange_count').notNull().default(0),
    tokenTotal: integer('token_total').notNull().default(0),
    startedBy: jsonb('started_by').notNull(), // ActorSchema (user)
}, (t) => ({
    vdIdx: index('vs_vd_idx').on(t.visionDocumentId),
    stateIdx: index('vs_state_idx').on(t.state),
}));
// ---------------------------------------------------------------------------
// vision_messages — separate from channel_posts (TRD-01 §4.6)
// ---------------------------------------------------------------------------
export const visionMessages = pgTable('vision_messages', {
    visionMessageId: uuid('vision_message_id').primaryKey(),
    visionSessionId: uuid('vision_session_id').notNull(),
    authorType: visionMessageAuthorEnum('author_type').notNull(),
    actor: jsonb('actor').notNull(), // ActorSchema
    body: text('body').notNull(),
    bodyTokens: integer('body_tokens').notNull(),
    parentMessageId: uuid('parent_message_id'),
    postedAt: timestamp('posted_at', { withTimezone: true }).notNull().defaultNow(),
    eventId: uuid('event_id').notNull(), // points at VisionMessageSent event
}, (t) => ({
    sessionIdx: index('vm_session_idx').on(t.visionSessionId, t.postedAt),
}));
// ---------------------------------------------------------------------------
// vision_questions + vision_answers
// ---------------------------------------------------------------------------
export const visionQuestions = pgTable('vision_questions', {
    visionQuestionId: uuid('vision_question_id').primaryKey(),
    visionSessionId: uuid('vision_session_id').notNull(),
    prompt: text('prompt').notNull(),
    category: text('category').notNull(),
    mandatory: integer('mandatory').notNull().default(0),
    status: visionQuestionStatusEnum('status').notNull().default('asked'),
    askedAt: timestamp('asked_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => ({
    sessionIdx: index('vq_session_idx').on(t.visionSessionId),
}));
export const visionAnswers = pgTable('vision_answers', {
    visionAnswerId: uuid('vision_answer_id').primaryKey(),
    visionQuestionId: uuid('vision_question_id').notNull(),
    answerText: text('answer_text').notNull(),
    answeredAt: timestamp('answered_at', { withTimezone: true }).notNull().defaultNow(),
    answeredBy: jsonb('answered_by').notNull(), // ActorSchema (user)
    visionMessageId: uuid('vision_message_id'),
}, (t) => ({
    questionIdx: index('va_question_idx').on(t.visionQuestionId),
}));
// ---------------------------------------------------------------------------
// vision_assumptions
// ---------------------------------------------------------------------------
export const visionAssumptions = pgTable('vision_assumptions', {
    visionAssumptionId: uuid('vision_assumption_id').primaryKey(),
    visionDocumentId: uuid('vision_document_id').notNull(),
    visionSessionId: uuid('vision_session_id').notNull(),
    text: text('text').notNull(),
    confidence: visionAssumptionConfidenceEnum('confidence').notNull().default('medium'),
    evidenceLink: text('evidence_link'),
    appendedAt: timestamp('appended_at', { withTimezone: true }).notNull().defaultNow(),
    appendedBy: jsonb('appended_by').notNull(), // ActorSchema (PM persona)
    rolledIntoVersionId: uuid('rolled_into_version_id'),
}, (t) => ({
    vdIdx: index('vas_vd_idx').on(t.visionDocumentId),
}));
//# sourceMappingURL=vision.js.map