/**
 * Drizzle schema for persona-library tables.
 *
 * Per TRD-03 §4.2 — personas, persona_versions, skills, skill_versions,
 * persona_skills, persona_capabilities, persona_model_affinities.
 *
 * Append-only enforcement on version tables is done via SQL triggers
 * in migration 0003_personas.sql.
 */
import { pgTable, uuid, text, jsonb, integer, boolean, timestamp, primaryKey, index, uniqueIndex, } from 'drizzle-orm/pg-core';
/** Re-use the existing audit schema for isolation consistency. */
export const publicSchema = pgTable;
// ---------------------------------------------------------------------------
// personas
// ---------------------------------------------------------------------------
export const personas = pgTable('personas', {
    personaId: uuid('persona_id').primaryKey(),
    slug: text('slug').notNull().unique(),
    origin: text('origin').notNull().$type(),
    currentVersionId: uuid('current_version_id'),
    isArchived: boolean('is_archived').notNull().default(false),
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'string' }),
    archivedReason: text('archived_reason'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
    createdByActor: jsonb('created_by_actor').notNull(),
});
// ---------------------------------------------------------------------------
// persona_versions
// ---------------------------------------------------------------------------
export const personaVersions = pgTable('persona_versions', {
    personaVersionId: uuid('persona_version_id').primaryKey(),
    personaId: uuid('persona_id')
        .notNull()
        .references(() => personas.personaId),
    versionNumber: integer('version_number').notNull(),
    roleBriefMd: text('role_brief_md').notNull(),
    definitionJson: jsonb('definition_json').notNull(),
    definitionHash: text('definition_hash').notNull(),
    escalationPolicy: jsonb('escalation_policy').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
    publishedByActor: jsonb('published_by_actor').notNull(),
    justification: text('justification').notNull(),
    parentVersionId: uuid('parent_version_id'),
    retroProposalId: uuid('retro_proposal_id'),
    schemaVersion: integer('schema_version').notNull(),
}, (t) => ({
    personaVersionUnique: uniqueIndex('persona_versions_persona_version_unique').on(t.personaId, t.versionNumber),
    hashIdx: index('persona_versions_hash_idx').on(t.definitionHash),
}));
// ---------------------------------------------------------------------------
// skills
// ---------------------------------------------------------------------------
export const skills = pgTable('skills', {
    skillId: uuid('skill_id').primaryKey(),
    slug: text('slug').notNull().unique(),
    origin: text('origin').notNull().$type(),
    currentVersionId: uuid('current_version_id'),
    isArchived: boolean('is_archived').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'string' }).notNull().defaultNow(),
});
// ---------------------------------------------------------------------------
// skill_versions
// ---------------------------------------------------------------------------
export const skillVersions = pgTable('skill_versions', {
    skillVersionId: uuid('skill_version_id').primaryKey(),
    skillId: uuid('skill_id')
        .notNull()
        .references(() => skills.skillId),
    versionNumber: integer('version_number').notNull(),
    frontmatterJson: jsonb('frontmatter_json').notNull(),
    bodyMd: text('body_md').notNull(),
    contentHash: text('content_hash').notNull(),
    publishedAt: timestamp('published_at', { withTimezone: true, mode: 'string' })
        .notNull()
        .defaultNow(),
    publishedByActor: jsonb('published_by_actor').notNull(),
    justification: text('justification').notNull(),
    parentVersionId: uuid('parent_version_id'),
    schemaVersion: integer('schema_version').notNull(),
}, (t) => ({
    skillVersionUnique: uniqueIndex('skill_versions_skill_version_unique').on(t.skillId, t.versionNumber),
}));
// ---------------------------------------------------------------------------
// persona_skills
// ---------------------------------------------------------------------------
export const personaSkills = pgTable('persona_skills', {
    personaVersionId: uuid('persona_version_id')
        .notNull()
        .references(() => personaVersions.personaVersionId),
    skillVersionId: uuid('skill_version_id')
        .notNull()
        .references(() => skillVersions.skillVersionId),
    required: boolean('required').notNull().default(true),
    ordering: integer('ordering').notNull(),
}, (t) => ({
    pk: primaryKey({ columns: [t.personaVersionId, t.skillVersionId] }),
    personaIdx: index('persona_skills_persona_idx').on(t.personaVersionId),
}));
// ---------------------------------------------------------------------------
// persona_capabilities
// ---------------------------------------------------------------------------
export const personaCapabilities = pgTable('persona_capabilities', {
    personaVersionId: uuid('persona_version_id')
        .primaryKey()
        .references(() => personaVersions.personaVersionId),
    defaultProfileJson: jsonb('default_profile_json').notNull(),
});
// ---------------------------------------------------------------------------
// persona_model_affinities
// ---------------------------------------------------------------------------
export const personaModelAffinities = pgTable('persona_model_affinities', {
    personaVersionId: uuid('persona_version_id')
        .notNull()
        .references(() => personaVersions.personaVersionId),
    riskClass: text('risk_class').notNull(),
    preferredModel: text('preferred_model').notNull(),
    fallbackModel: text('fallback_model'),
    maxTokensHint: integer('max_tokens_hint'),
    rationale: text('rationale').notNull(),
}, (t) => ({
    pk: primaryKey({ columns: [t.personaVersionId, t.riskClass] }),
}));
//# sourceMappingURL=personas.js.map