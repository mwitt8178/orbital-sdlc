/**
 * projects.ts — Drizzle schema for the multi-project boundary.
 *
 * Per Round 4 Projects Feature spec.
 *
 * A "project" is the top-level grouping for a Monday board + Github repo + a
 * stream of sprints/visions/channels/UAT/retros. An install can have N projects;
 * for back-compat a single "Default Project" is bootstrapped on first boot
 * and any pre-existing aggregate rows are backfilled to it (handled at runtime
 * by ensureDefaultProject(), not in the SQL migration — the SQL migration
 * cannot read install_id).
 *
 * Cross-context references (NOT redefined here):
 *   - epics.project_id, stories.project_id, sprints.project_id          (backlog)
 *   - vision_versions.project_id                                         (vision)
 *   - channels.project_id, ceremonies.project_id                         (comms)
 *   - retro_reports.project_id                                           (retros)
 *   - uat_sessions.project_id                                            (uat)
 *   - tasks.project_id                                                   (orchestration)
 *
 * Per TRD-01 §4.5 cross-context references are nullable uuid columns without
 * physical FKs. Same convention applied to project_id.
 *
 * Within-context FKs: none. (`projects.created_by_event_id` is conceptually a
 * pointer into audit.events but we follow the same nullable-uuid convention to
 * stay DSQL-portable.)
 */
import { pgTable, uuid, text, timestamp, integer, index, uniqueIndex } from 'drizzle-orm/pg-core';
// ---------------------------------------------------------------------------
// projects
// ---------------------------------------------------------------------------
export const projects = pgTable('projects', {
    projectId: uuid('project_id').primaryKey(),
    /**
     * Round 7-01 — Multi-tenant scoping.
     * Sentinel '00000000-0000-0000-0000-000000000000' = local-install default.
     * [Engineer-Sr · Sonnet · run-round7-01-extract-hub]
     */
    tenantId: uuid('tenant_id').notNull().default('00000000-0000-0000-0000-000000000000'),
    /** install_id from ~/.orbital/config/install.json. Logical FK only. */
    installId: uuid('install_id').notNull(),
    name: text('name').notNull(),
    /** URL-friendly slug; unique within an install. */
    slug: text('slug').notNull(),
    description: text('description'),
    /** Monday.com board ID (string per Monday API). NULL until connected. */
    mondayBoardId: text('monday_board_id'),
    /** Github owner (user or org login). NULL until connected. */
    githubOwner: text('github_owner'),
    /** Github repo name. NULL until connected. */
    githubRepo: text('github_repo'),
    /** Default branch; required so worktrees can branch off something. */
    githubDefaultBranch: text('github_default_branch').notNull().default('main'),
    /** Soft-delete flag. NULL = active. */
    archivedAt: timestamp('archived_at', { withTimezone: true, mode: 'date' }),
    /** Logical FK into audit.events. Helps trace creation provenance. */
    createdByEventId: uuid('created_by_event_id'),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' })
        .notNull()
        .defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' })
        .notNull()
        .defaultNow(),
    schemaVersion: integer('schema_version').notNull().default(1),
}, (t) => ({
    installSlugUq: uniqueIndex('projects_install_slug_uq').on(t.installId, t.slug),
    byInstall: index('projects_install_idx').on(t.installId),
    byArchived: index('projects_archived_idx').on(t.archivedAt),
}));
//# sourceMappingURL=projects.js.map