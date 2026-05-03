/**
 * backlog.ts — Drizzle schema for Phase 4B backlog + sprint + Monday-sync tables.
 *
 * Per TRD-02 v0.2 §4.
 *
 * Owned tables (this file):
 *   - epics
 *   - stories
 *   - story_acceptance_criteria
 *   - sprints
 *   - sprint_commitments
 *   - monday_sync_state
 *
 * Cross-context references (NOT redefined here):
 *   - tasks, task_dependencies → owned by TRD-04 (db/schema/orchestration.ts)
 *   - defects → owned by TRD-11 (future migration)
 *   - vision_versions → owned by TRD-01 (Phase 4A migration 0009)
 *
 * Within-context FKs (allowed): stories.epic_id → epics.epic_id;
 * story_acceptance_criteria.story_id → stories.story_id ON DELETE CASCADE.
 * Cross-context references are nullable uuid columns without physical FKs
 * (consistent with TRD-04 §4.1 reconciliation note pattern).
 *
 * Migration 0018 (auto_generated_metadata):
 *   - epics.auto_generated_metadata  (nullable jsonb)
 *   - stories.auto_generated_metadata (nullable jsonb)
 *   Set by VisionAutoDecomposeSubscriber when auto-generating starter backlog
 *   from a locked vision. Shape: { source, vision_document_id, version }.
 */
export declare const EPIC_STATUS: readonly ["draft", "active", "completed", "archived", "cancelled"];
export type EpicStatus = (typeof EPIC_STATUS)[number];
export declare const STORY_STATUS: readonly ["backlog", "ready", "in_progress", "in_review", "done", "accepted", "blocked", "defective", "cancelled"];
export type StoryStatus = (typeof STORY_STATUS)[number];
export declare const SPRINT_STATUS: readonly ["planning", "ready", "active", "completing", "completed", "paused"];
export type SprintStatus = (typeof SPRINT_STATUS)[number];
export declare const SPRINT_PRIORITY_CLASS: readonly ["critical", "standard", "background"];
export type SprintPriorityClass = (typeof SPRINT_PRIORITY_CLASS)[number];
export declare const MONDAY_AGGREGATE_TYPE: readonly ["epic", "story", "task", "sprint", "defect"];
export type MondayAggregateType = (typeof MONDAY_AGGREGATE_TYPE)[number];
/**
 * Per TRD-02 v0.2 §4.1.
 *
 * One epic groups N stories. Linked to a vision version. Priority is dense.
 */
export declare const epics: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "epics";
    schema: undefined;
    columns: {
        epicId: import("drizzle-orm/pg-core").PgColumn<{
            name: "epic_id";
            tableName: "epics";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        tenantId: import("drizzle-orm/pg-core").PgColumn<{
            name: "tenant_id";
            tableName: "epics";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        visionVersionId: import("drizzle-orm/pg-core").PgColumn<{
            name: "vision_version_id";
            tableName: "epics";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        title: import("drizzle-orm/pg-core").PgColumn<{
            name: "title";
            tableName: "epics";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        rationale: import("drizzle-orm/pg-core").PgColumn<{
            name: "rationale";
            tableName: "epics";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        priority: import("drizzle-orm/pg-core").PgColumn<{
            name: "priority";
            tableName: "epics";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        mondayGroupId: import("drizzle-orm/pg-core").PgColumn<{
            name: "monday_group_id";
            tableName: "epics";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        status: import("drizzle-orm/pg-core").PgColumn<{
            name: "status";
            tableName: "epics";
            dataType: "string";
            columnType: "PgText";
            data: "cancelled" | "draft" | "active" | "completed" | "archived";
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["draft", "active", "completed", "archived", "cancelled"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        autoGeneratedMetadata: import("drizzle-orm/pg-core").PgColumn<{
            name: "auto_generated_metadata";
            tableName: "epics";
            dataType: "json";
            columnType: "PgJsonb";
            data: {
                source: "vision_lock";
                vision_document_id: string;
                version: number;
            } | null;
            driverParam: unknown;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "epics";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "epics";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        schemaVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "schema_version";
            tableName: "epics";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export type EpicRow = typeof epics.$inferSelect;
export type EpicInsert = typeof epics.$inferInsert;
/**
 * Per TRD-02 v0.2 §4.1.
 */
export declare const stories: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "stories";
    schema: undefined;
    columns: {
        storyId: import("drizzle-orm/pg-core").PgColumn<{
            name: "story_id";
            tableName: "stories";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        tenantId: import("drizzle-orm/pg-core").PgColumn<{
            name: "tenant_id";
            tableName: "stories";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        epicId: import("drizzle-orm/pg-core").PgColumn<{
            name: "epic_id";
            tableName: "stories";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        title: import("drizzle-orm/pg-core").PgColumn<{
            name: "title";
            tableName: "stories";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        description: import("drizzle-orm/pg-core").PgColumn<{
            name: "description";
            tableName: "stories";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        status: import("drizzle-orm/pg-core").PgColumn<{
            name: "status";
            tableName: "stories";
            dataType: "string";
            columnType: "PgText";
            data: "cancelled" | "backlog" | "ready" | "in_progress" | "in_review" | "done" | "accepted" | "blocked" | "defective";
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["backlog", "ready", "in_progress", "in_review", "done", "accepted", "blocked", "defective", "cancelled"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        storyPoints: import("drizzle-orm/pg-core").PgColumn<{
            name: "story_points";
            tableName: "stories";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        priority: import("drizzle-orm/pg-core").PgColumn<{
            name: "priority";
            tableName: "stories";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        personaOfRecord: import("drizzle-orm/pg-core").PgColumn<{
            name: "persona_of_record";
            tableName: "stories";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        mondayItemId: import("drizzle-orm/pg-core").PgColumn<{
            name: "monday_item_id";
            tableName: "stories";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        originStoryId: import("drizzle-orm/pg-core").PgColumn<{
            name: "origin_story_id";
            tableName: "stories";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        defectId: import("drizzle-orm/pg-core").PgColumn<{
            name: "defect_id";
            tableName: "stories";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        linkedArtifacts: import("drizzle-orm/pg-core").PgColumn<{
            name: "linked_artifacts";
            tableName: "stories";
            dataType: "json";
            columnType: "PgJsonb";
            data: {
                type: string;
                id: string;
                url?: string;
            }[];
            driverParam: unknown;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        autoGeneratedMetadata: import("drizzle-orm/pg-core").PgColumn<{
            name: "auto_generated_metadata";
            tableName: "stories";
            dataType: "json";
            columnType: "PgJsonb";
            data: {
                source: "vision_lock";
                vision_document_id: string;
                version: number;
            } | null;
            driverParam: unknown;
            notNull: false;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "stories";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "stories";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        schemaVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "schema_version";
            tableName: "stories";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export type StoryRow = typeof stories.$inferSelect;
export type StoryInsert = typeof stories.$inferInsert;
/**
 * Per TRD-02 v0.2 §4.1. ACs are first-class so UAT (TRD-11) can reference
 * individual ACs by ID. ON DELETE CASCADE is appropriate within the backlog
 * context.
 */
export declare const storyAcceptanceCriteria: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "story_acceptance_criteria";
    schema: undefined;
    columns: {
        acId: import("drizzle-orm/pg-core").PgColumn<{
            name: "ac_id";
            tableName: "story_acceptance_criteria";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        tenantId: import("drizzle-orm/pg-core").PgColumn<{
            name: "tenant_id";
            tableName: "story_acceptance_criteria";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        storyId: import("drizzle-orm/pg-core").PgColumn<{
            name: "story_id";
            tableName: "story_acceptance_criteria";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        ordinal: import("drizzle-orm/pg-core").PgColumn<{
            name: "ordinal";
            tableName: "story_acceptance_criteria";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        text: import("drizzle-orm/pg-core").PgColumn<{
            name: "text";
            tableName: "story_acceptance_criteria";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        verifierHint: import("drizzle-orm/pg-core").PgColumn<{
            name: "verifier_hint";
            tableName: "story_acceptance_criteria";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "story_acceptance_criteria";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        schemaVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "schema_version";
            tableName: "story_acceptance_criteria";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export type StoryAcceptanceCriterionRow = typeof storyAcceptanceCriteria.$inferSelect;
export type StoryAcceptanceCriterionInsert = typeof storyAcceptanceCriteria.$inferInsert;
/**
 * Per TRD-02 v0.2 §4.3.
 *
 * Multi-sprint coordination via concurrencyShare + priorityClass.
 */
export declare const sprints: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "sprints";
    schema: undefined;
    columns: {
        sprintId: import("drizzle-orm/pg-core").PgColumn<{
            name: "sprint_id";
            tableName: "sprints";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        tenantId: import("drizzle-orm/pg-core").PgColumn<{
            name: "tenant_id";
            tableName: "sprints";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        name: import("drizzle-orm/pg-core").PgColumn<{
            name: "name";
            tableName: "sprints";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        sequence: import("drizzle-orm/pg-core").PgColumn<{
            name: "sequence";
            tableName: "sprints";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        status: import("drizzle-orm/pg-core").PgColumn<{
            name: "status";
            tableName: "sprints";
            dataType: "string";
            columnType: "PgText";
            data: "active" | "completed" | "ready" | "planning" | "completing" | "paused";
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["planning", "ready", "active", "completing", "completed", "paused"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        storyPointCapacity: import("drizzle-orm/pg-core").PgColumn<{
            name: "story_point_capacity";
            tableName: "sprints";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        wallClockTargetMs: import("drizzle-orm/pg-core").PgColumn<{
            name: "wall_clock_target_ms";
            tableName: "sprints";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        budgetUsdCents: import("drizzle-orm/pg-core").PgColumn<{
            name: "budget_usd_cents";
            tableName: "sprints";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        concurrencyShare: import("drizzle-orm/pg-core").PgColumn<{
            name: "concurrency_share";
            tableName: "sprints";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        priorityClass: import("drizzle-orm/pg-core").PgColumn<{
            name: "priority_class";
            tableName: "sprints";
            dataType: "string";
            columnType: "PgText";
            data: "critical" | "standard" | "background";
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["critical", "standard", "background"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        sprintChannelId: import("drizzle-orm/pg-core").PgColumn<{
            name: "sprint_channel_id";
            tableName: "sprints";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        mondayBoardGroupId: import("drizzle-orm/pg-core").PgColumn<{
            name: "monday_board_group_id";
            tableName: "sprints";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        startedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "started_at";
            tableName: "sprints";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        pausedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "paused_at";
            tableName: "sprints";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        completedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "completed_at";
            tableName: "sprints";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        pauseState: import("drizzle-orm/pg-core").PgColumn<{
            name: "pause_state";
            tableName: "sprints";
            dataType: "json";
            columnType: "PgJsonb";
            data: SprintPauseState | null;
            driverParam: unknown;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "sprints";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "sprints";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        schemaVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "schema_version";
            tableName: "sprints";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export type SprintRow = typeof sprints.$inferSelect;
export type SprintInsert = typeof sprints.$inferInsert;
export interface SprintPauseState {
    in_flight_task_ids: string[];
    worker_session_ids: string[];
    capability_ids_to_revoke: string[];
    dag_cursor: {
        ready: string[];
        pending: string[];
    };
    paused_at: string;
}
/**
 * Per TRD-02 v0.2 §4.3.
 *
 * One commitment row per sprint, written by the planning ceremony's chair (or
 * synthetically by the SprintService for non-ceremony-driven sprints).
 */
export declare const sprintCommitments: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "sprint_commitments";
    schema: undefined;
    columns: {
        commitmentId: import("drizzle-orm/pg-core").PgColumn<{
            name: "commitment_id";
            tableName: "sprint_commitments";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        tenantId: import("drizzle-orm/pg-core").PgColumn<{
            name: "tenant_id";
            tableName: "sprint_commitments";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        sprintId: import("drizzle-orm/pg-core").PgColumn<{
            name: "sprint_id";
            tableName: "sprint_commitments";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        ceremonyId: import("drizzle-orm/pg-core").PgColumn<{
            name: "ceremony_id";
            tableName: "sprint_commitments";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        selectedStoryIds: import("drizzle-orm/pg-core").PgColumn<{
            name: "selected_story_ids";
            tableName: "sprint_commitments";
            dataType: "json";
            columnType: "PgJsonb";
            data: string[];
            driverParam: unknown;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        capacityUsedPoints: import("drizzle-orm/pg-core").PgColumn<{
            name: "capacity_used_points";
            tableName: "sprint_commitments";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        identifiedRisks: import("drizzle-orm/pg-core").PgColumn<{
            name: "identified_risks";
            tableName: "sprint_commitments";
            dataType: "json";
            columnType: "PgJsonb";
            data: {
                risk: string;
                severity: "low" | "medium" | "high";
                mitigation: string | null;
            }[];
            driverParam: unknown;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        raisedConcerns: import("drizzle-orm/pg-core").PgColumn<{
            name: "raised_concerns";
            tableName: "sprint_commitments";
            dataType: "json";
            columnType: "PgJsonb";
            data: {
                raisedBy: string;
                concern: string;
                disposition: "accepted" | "deferred" | "rejected";
                rationale: string;
            }[];
            driverParam: unknown;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        isPartial: import("drizzle-orm/pg-core").PgColumn<{
            name: "is_partial";
            tableName: "sprint_commitments";
            dataType: "boolean";
            columnType: "PgBoolean";
            data: boolean;
            driverParam: boolean;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "sprint_commitments";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        schemaVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "schema_version";
            tableName: "sprint_commitments";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export type SprintCommitmentRow = typeof sprintCommitments.$inferSelect;
export type SprintCommitmentInsert = typeof sprintCommitments.$inferInsert;
/**
 * Per TRD-02 v0.2 §4.4.
 *
 * Bidirectional drift-aware sync mapping for a single Orbital aggregate to
 * Monday.com. last_seen_item_ids is added in this phase to track items the
 * reconciliation pull last observed (TRD-02 §13.3).
 */
export declare const mondaySyncState: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "monday_sync_state";
    schema: undefined;
    columns: {
        syncStateId: import("drizzle-orm/pg-core").PgColumn<{
            name: "sync_state_id";
            tableName: "monday_sync_state";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        aggregateType: import("drizzle-orm/pg-core").PgColumn<{
            name: "aggregate_type";
            tableName: "monday_sync_state";
            dataType: "string";
            columnType: "PgText";
            data: "epic" | "story" | "task" | "sprint" | "defect";
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["epic", "story", "task", "sprint", "defect"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        aggregateId: import("drizzle-orm/pg-core").PgColumn<{
            name: "aggregate_id";
            tableName: "monday_sync_state";
            dataType: "string";
            columnType: "PgUUID";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        mondayId: import("drizzle-orm/pg-core").PgColumn<{
            name: "monday_id";
            tableName: "monday_sync_state";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        lastPushAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "last_push_at";
            tableName: "monday_sync_state";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        lastPullAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "last_pull_at";
            tableName: "monday_sync_state";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        lastPushHash: import("drizzle-orm/pg-core").PgColumn<{
            name: "last_push_hash";
            tableName: "monday_sync_state";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        lastPullHash: import("drizzle-orm/pg-core").PgColumn<{
            name: "last_pull_hash";
            tableName: "monday_sync_state";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        lastSeenItemIds: import("drizzle-orm/pg-core").PgColumn<{
            name: "last_seen_item_ids";
            tableName: "monday_sync_state";
            dataType: "json";
            columnType: "PgJsonb";
            data: string[];
            driverParam: unknown;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        driftDetectedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "drift_detected_at";
            tableName: "monday_sync_state";
            dataType: "date";
            columnType: "PgTimestamp";
            data: Date;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        syncErrorCount: import("drizzle-orm/pg-core").PgColumn<{
            name: "sync_error_count";
            tableName: "monday_sync_state";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        lastError: import("drizzle-orm/pg-core").PgColumn<{
            name: "last_error";
            tableName: "monday_sync_state";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        schemaVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "schema_version";
            tableName: "monday_sync_state";
            dataType: "number";
            columnType: "PgInteger";
            data: number;
            driverParam: string | number;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
    };
    dialect: "pg";
}>;
export type MondaySyncStateRow = typeof mondaySyncState.$inferSelect;
export type MondaySyncStateInsert = typeof mondaySyncState.$inferInsert;
//# sourceMappingURL=backlog.d.ts.map