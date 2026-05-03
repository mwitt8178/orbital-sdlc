/**
 * comms-workflow.ts — Drizzle schema for Phase 3A blocker / ceremony /
 * conflict-resolution / ADR tables.
 *
 * Per TRD-05 §4.3, §4.4, §4.5.
 *
 * Owned tables (this file):
 *   - blockers
 *   - ceremony_specifications
 *   - ceremonies
 *   - ceremony_participants
 *   - ceremony_outputs
 *   - disagreements
 *   - tie_breaker_decisions
 *   - adrs
 *
 * `adrs` carries an immutability trigger declared in 0007_comms.sql;
 * supersession is the only mutation allowed.
 */

import {
  pgTable,
  uuid,
  text,
  jsonb,
  integer,
  boolean,
  timestamp,
  index,
  uniqueIndex,
} from 'drizzle-orm/pg-core'

// ---------------------------------------------------------------------------
// Enum constants
// ---------------------------------------------------------------------------

export const BLOCKER_STATE = [
  'raised',
  'routed',
  'in_resolution',
  'resolved',
  'escalated',
  'abandoned',
] as const
export type BlockerState = (typeof BLOCKER_STATE)[number]

export const BLOCKER_URGENCY = ['low', 'normal', 'high', 'critical'] as const
export type BlockerUrgency = (typeof BLOCKER_URGENCY)[number]

export const CEREMONY_TYPE = [
  'sprint_planning',
  'backlog_grooming',
  'architecture_review',
  'async_standup',
  'sprint_retrospective',
  'ad_hoc',
] as const
export type CeremonyType = (typeof CEREMONY_TYPE)[number]

export const CEREMONY_STATE = [
  'scheduled',
  'in_progress',
  'voting',
  'output_writing',
  'closed',
  'aborted',
] as const
export type CeremonyState = (typeof CEREMONY_STATE)[number]

export const CEREMONY_VOTE_RULE = ['simple_majority', 'unanimous', 'chair_decides'] as const
export type CeremonyVoteRule = (typeof CEREMONY_VOTE_RULE)[number]

export const CEREMONY_PARTICIPANT_ROLE = ['chair', 'participant', 'observer'] as const
export type CeremonyParticipantRole = (typeof CEREMONY_PARTICIPANT_ROLE)[number]

export const CEREMONY_VOTE = [
  'approve',
  'reject',
  'abstain',
  'approve_with_modifications',
] as const
export type CeremonyVote = (typeof CEREMONY_VOTE)[number]

export const CEREMONY_OUTPUT_KIND = [
  'sprint_commitment',
  'refined_backlog',
  'adr',
  'standup_digest',
  'retro_outcome',
  'partial',
] as const
export type CeremonyOutputKind = (typeof CEREMONY_OUTPUT_KIND)[number]

export const DISAGREEMENT_STATE = [
  'raised',
  'tie_breaker_assigned',
  'resolved',
  'escalated',
  'abandoned',
] as const
export type DisagreementState = (typeof DISAGREEMENT_STATE)[number]

export const DISAGREEMENT_DOMAIN = ['technical', 'product', 'security', 'cross_cutting'] as const
export type DisagreementDomain = (typeof DISAGREEMENT_DOMAIN)[number]

export const ADR_STATUS = ['proposed', 'accepted', 'superseded'] as const
export type AdrStatus = (typeof ADR_STATUS)[number]

// ---------------------------------------------------------------------------
// blockers
// ---------------------------------------------------------------------------

export const blockers = pgTable(
  'blockers',
  {
    blockerId: uuid('blocker_id').primaryKey(),
    raisingActor: jsonb('raising_actor').$type<Record<string, unknown>>().notNull(),
    raisingTaskId: uuid('raising_task_id').notNull(),
    ticketId: text('ticket_id'),
    question: text('question').notNull(),
    context: text('context').notNull(),
    requestedResolverRole: text('requested_resolver_role').notNull(),
    urgency: text('urgency', { enum: BLOCKER_URGENCY }).notNull().default('normal'),
    state: text('state', { enum: BLOCKER_STATE }).notNull().default('raised'),
    routedToActor: jsonb('routed_to_actor').$type<Record<string, unknown>>(),
    routedToTaskId: uuid('routed_to_task_id'),
    routingAttempts: integer('routing_attempts').notNull().default(0),
    maxRoutingAttempts: integer('max_routing_attempts').notNull().default(2),
    originPostId: uuid('origin_post_id'),
    resolutionPostId: uuid('resolution_post_id'),
    raisedAt: timestamp('raised_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    escalatedAt: timestamp('escalated_at', { withTimezone: true, mode: 'date' }),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    stateIdx: index('blockers_state_idx').on(t.state, t.raisedAt),
    ticketIdx: index('blockers_ticket_idx').on(t.ticketId),
  }),
)

export type BlockerRow = typeof blockers.$inferSelect
export type BlockerInsert = typeof blockers.$inferInsert

// ---------------------------------------------------------------------------
// ceremony_specifications
// ---------------------------------------------------------------------------

export const ceremonySpecifications = pgTable(
  'ceremony_specifications',
  {
    specId: uuid('spec_id').primaryKey(),
    ceremonyType: text('ceremony_type', { enum: CEREMONY_TYPE }).notNull(),
    version: integer('version').notNull(),
    chairRole: text('chair_role').notNull(),
    participantRoles: jsonb('participant_roles').$type<string[]>().notNull(),
    agendaTemplate: text('agenda_template').notNull(),
    /** Serialized Zod / JSON-Schema for output validation. */
    outputSchemaJson: jsonb('output_schema_json').$type<Record<string, unknown>>().notNull(),
    defaultTurnsPerParticipant: integer('default_turns_per_participant').notNull(),
    defaultTokensPerTurn: integer('default_tokens_per_turn').notNull(),
    defaultWallClockMs: integer('default_wall_clock_ms').notNull(),
    voteRequired: boolean('vote_required').notNull().default(true),
    voteRule: text('vote_rule', { enum: CEREMONY_VOTE_RULE }).notNull(),
    schemaVersion: integer('schema_version').notNull().default(1),
    loadedAt: timestamp('loaded_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
  },
  (t) => ({
    typeVersionUnique: uniqueIndex('ceremony_specs_type_version_unique').on(
      t.ceremonyType,
      t.version,
    ),
  }),
)

export type CeremonySpecificationRow = typeof ceremonySpecifications.$inferSelect
export type CeremonySpecificationInsert = typeof ceremonySpecifications.$inferInsert

// ---------------------------------------------------------------------------
// ceremonies
// ---------------------------------------------------------------------------

export const ceremonies = pgTable(
  'ceremonies',
  {
    ceremonyId: uuid('ceremony_id').primaryKey(),
    ceremonyType: text('ceremony_type', { enum: CEREMONY_TYPE }).notNull(),
    specId: uuid('spec_id').notNull(),
    channelId: uuid('channel_id').notNull(),
    state: text('state', { enum: CEREMONY_STATE }).notNull().default('scheduled'),
    triggeredBy: jsonb('triggered_by').$type<Record<string, unknown>>().notNull(),
    agendaPostId: uuid('agenda_post_id'),
    scope: jsonb('scope').$type<Record<string, unknown>>().notNull(),
    turnsPerParticipant: integer('turns_per_participant').notNull(),
    tokensPerTurn: integer('tokens_per_turn').notNull(),
    wallClockBudgetMs: integer('wall_clock_budget_ms').notNull(),
    /** Aggregate token consumption across all turns; advisory monitor field. */
    tokensConsumedTotal: integer('tokens_consumed_total').notNull().default(0),
    /** Vote rule applied to this ceremony (snapshot of spec at scheduling time). */
    voteRule: text('vote_rule', { enum: CEREMONY_VOTE_RULE }).notNull(),
    voteRequired: boolean('vote_required').notNull().default(true),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    startedAt: timestamp('started_at', { withTimezone: true, mode: 'date' }),
    closedAt: timestamp('closed_at', { withTimezone: true, mode: 'date' }),
    abortedAt: timestamp('aborted_at', { withTimezone: true, mode: 'date' }),
    abortReason: text('abort_reason'),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    stateIdx: index('ceremonies_state_idx').on(t.state, t.scheduledAt),
    typeIdx: index('ceremonies_type_idx').on(t.ceremonyType),
  }),
)

export type CeremonyRow = typeof ceremonies.$inferSelect
export type CeremonyInsert = typeof ceremonies.$inferInsert

// ---------------------------------------------------------------------------
// ceremony_participants
// ---------------------------------------------------------------------------

export const ceremonyParticipants = pgTable(
  'ceremony_participants',
  {
    participantId: uuid('participant_id').primaryKey(),
    ceremonyId: uuid('ceremony_id')
      .notNull()
      .references(() => ceremonies.ceremonyId),
    personaRole: text('persona_role').notNull(),
    personaId: text('persona_id').notNull(),
    sessionId: text('session_id').notNull(),
    ceremonyRole: text('ceremony_role', { enum: CEREMONY_PARTICIPANT_ROLE }).notNull(),
    turnsUsed: integer('turns_used').notNull().default(0),
    turnsAllowed: integer('turns_allowed').notNull(),
    yieldedAt: timestamp('yielded_at', { withTimezone: true, mode: 'date' }),
    voteCast: text('vote_cast', { enum: CEREMONY_VOTE }),
    voteCastAt: timestamp('vote_cast_at', { withTimezone: true, mode: 'date' }),
  },
  (t) => ({
    ceremonyParticipantUnique: uniqueIndex('cer_participant_unique').on(
      t.ceremonyId,
      t.personaRole,
      t.sessionId,
    ),
  }),
)

export type CeremonyParticipantRow = typeof ceremonyParticipants.$inferSelect
export type CeremonyParticipantInsert = typeof ceremonyParticipants.$inferInsert

// ---------------------------------------------------------------------------
// ceremony_outputs
// ---------------------------------------------------------------------------

export const ceremonyOutputs = pgTable('ceremony_outputs', {
  outputId: uuid('output_id').primaryKey(),
  ceremonyId: uuid('ceremony_id')
    .notNull()
    .references(() => ceremonies.ceremonyId),
  outputKind: text('output_kind', { enum: CEREMONY_OUTPUT_KIND }).notNull(),
  payload: jsonb('payload').$type<Record<string, unknown>>().notNull(),
  authoredByActor: jsonb('authored_by_actor').$type<Record<string, unknown>>().notNull(),
  capabilityId: uuid('capability_id').notNull(),
  linkedAdrId: uuid('linked_adr_id'),
  isPartial: boolean('is_partial').notNull().default(false),
  unresolvedItems: jsonb('unresolved_items').$type<string[]>().notNull().default([]),
  writtenAt: timestamp('written_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  schemaVersion: integer('schema_version').notNull().default(1),
})

export type CeremonyOutputRow = typeof ceremonyOutputs.$inferSelect
export type CeremonyOutputInsert = typeof ceremonyOutputs.$inferInsert

// ---------------------------------------------------------------------------
// disagreements
// ---------------------------------------------------------------------------

export const disagreements = pgTable(
  'disagreements',
  {
    disagreementId: uuid('disagreement_id').primaryKey(),
    domain: text('domain', { enum: DISAGREEMENT_DOMAIN }).notNull(),
    state: text('state', { enum: DISAGREEMENT_STATE }).notNull().default('raised'),
    detectionMode: text('detection_mode', {
      enum: ['explicit_flag', 'orchestrator_heuristic'],
    }).notNull(),
    artifactRef: jsonb('artifact_ref').$type<{ type: string; id: string }>().notNull(),
    /** [{ actor, position_summary, evidence_refs[] }] */
    positions: jsonb('positions').$type<Array<Record<string, unknown>>>().notNull(),
    raisedAt: timestamp('raised_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    tieBreakerAssignedAt: timestamp('tie_breaker_assigned_at', {
      withTimezone: true,
      mode: 'date',
    }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true, mode: 'date' }),
    escalatedAt: timestamp('escalated_at', { withTimezone: true, mode: 'date' }),
    retroFlagged: boolean('retro_flagged').notNull().default(false),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    stateIdx: index('disagreements_state_idx').on(t.state),
    domainIdx: index('disagreements_domain_idx').on(t.domain),
  }),
)

export type DisagreementRow = typeof disagreements.$inferSelect
export type DisagreementInsert = typeof disagreements.$inferInsert

// ---------------------------------------------------------------------------
// tie_breaker_decisions
// ---------------------------------------------------------------------------

export const tieBreakerDecisions = pgTable('tie_breaker_decisions', {
  decisionId: uuid('decision_id').primaryKey(),
  disagreementId: uuid('disagreement_id')
    .notNull()
    .references(() => disagreements.disagreementId),
  tieBreakerActor: jsonb('tie_breaker_actor').$type<Record<string, unknown>>().notNull(),
  tieBreakerRole: text('tie_breaker_role').notNull(),
  decisionText: text('decision_text').notNull(),
  rationale: text('rationale').notNull(),
  adrId: uuid('adr_id'),
  capabilityId: uuid('capability_id').notNull(),
  decidedAt: timestamp('decided_at', { withTimezone: true, mode: 'date' })
    .notNull()
    .defaultNow(),
  schemaVersion: integer('schema_version').notNull().default(1),
})

export type TieBreakerDecisionRow = typeof tieBreakerDecisions.$inferSelect
export type TieBreakerDecisionInsert = typeof tieBreakerDecisions.$inferInsert

// ---------------------------------------------------------------------------
// adrs
// ---------------------------------------------------------------------------

export const adrs = pgTable(
  'adrs',
  {
    adrId: uuid('adr_id').primaryKey(),
    /** Monotonic per install: 'ADR-014'. */
    adrNumber: integer('adr_number').notNull(),
    title: text('title').notNull(),
    status: text('status', { enum: ADR_STATUS }).notNull(),
    context: text('context').notNull(),
    decision: text('decision').notNull(),
    rationale: text('rationale').notNull(),
    /** { positive: string[], negative: string[], risks: string[] } */
    consequences: jsonb('consequences').$type<Record<string, string[]>>().notNull(),
    /** [{ option, why_rejected }] */
    alternatives: jsonb('alternatives').$type<Array<Record<string, string>>>().notNull(),
    authoredByActor: jsonb('authored_by_actor').$type<Record<string, unknown>>().notNull(),
    authoredByRole: text('authored_by_role').notNull(),
    capabilityId: uuid('capability_id').notNull(),
    ceremonyId: uuid('ceremony_id'),
    disagreementId: uuid('disagreement_id'),
    supersedesAdrId: uuid('supersedes_adr_id'),
    supersededByAdrId: uuid('superseded_by_adr_id'),
    linkedTickets: jsonb('linked_tickets').$type<string[]>().notNull().default([]),
    immutable: boolean('immutable').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    schemaVersion: integer('schema_version').notNull().default(1),
  },
  (t) => ({
    adrNumberUnique: uniqueIndex('adrs_number_unique').on(t.adrNumber),
    statusIdx: index('adrs_status_idx').on(t.status),
  }),
)

export type AdrRow = typeof adrs.$inferSelect
export type AdrInsert = typeof adrs.$inferInsert
