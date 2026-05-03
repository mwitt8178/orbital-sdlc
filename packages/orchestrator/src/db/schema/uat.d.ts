/**
 * uat.ts — Drizzle schema for Phase 5A UAT workflow tables.
 *
 * Per TRD-11 v0.2 §4.
 *
 * Owned tables (this file):
 *   - uat_sessions
 *   - uat_ac_results
 *   - defects
 *   - defect_lineage
 *   - persona_of_record_links
 *
 * Cross-context references (NOT redefined here):
 *   - story_acceptance_criteria.ac_id → owned by TRD-02 (db/schema/backlog.ts)
 *   - tasks.task_id, tasks.persona_id → owned by TRD-04 (db/schema/orchestration.ts)
 *   - capability_grants → owned by TRD-06 (db/schema/capabilities.ts)
 *
 * Within-context FKs: uat_ac_results → uat_sessions; defects → uat_sessions + uat_ac_results;
 * defect_lineage → defects (unique). Cross-context references are nullable uuid columns
 * without physical FKs (consistent with TRD-04 §4.1 reconciliation note pattern).
 *
 * Note on fixing_ticket_id (TRD-11 §4.3 cross-TRD contract):
 *   This column is defined here but populated by TRD-02's defect-promotion handler
 *   when a defect fix story is created. Value = TRD-02 stories.story_id. NULL until promoted.
 */
export declare const UAT_SESSION_STATE: readonly ["started", "in_progress", "submitted", "accepted", "partially_accepted", "rejected"];
export type UATSessionState = (typeof UAT_SESSION_STATE)[number];
export declare const UAT_AC_STATUS: readonly ["pending", "pass", "fail"];
export type UATACStatus = (typeof UAT_AC_STATUS)[number];
export declare const DEFECT_SEVERITY: readonly ["critical", "high", "medium", "low"];
export type DefectSeverity = (typeof DEFECT_SEVERITY)[number];
export declare const DEFECT_STATE: readonly ["open", "triaged", "assigned", "in_progress", "resolved", "verified", "reopened", "closed"];
export type DefectState = (typeof DEFECT_STATE)[number];
export declare const POR_ROLE: readonly ["implementation", "verification", "review", "tests", "design", "architecture"];
export type PORRole = (typeof POR_ROLE)[number];
/**
 * Per TRD-11 v0.2 §4.1.
 *
 * One session = one human pass over a feature's AC list.
 * A story can have multiple sessions (one per re-UAT after defect fix).
 * UNIQUE (ticket_id, session_version) enforced via constraint.
 *
 * assumptions_snapshot: materialised at session start per §4.6; stores
 * the union of vision-source and worker-source assumptions frozen at start.
 */
export declare const uatSessions: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "uat_sessions";
    schema: undefined;
    columns: {
        uatSessionId: import("drizzle-orm/pg-core").PgColumn<{
            name: "uat_session_id";
            tableName: "uat_sessions";
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
            tableName: "uat_sessions";
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
        ticketId: import("drizzle-orm/pg-core").PgColumn<{
            name: "ticket_id";
            tableName: "uat_sessions";
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
        storyVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "story_version";
            tableName: "uat_sessions";
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
        sessionVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "session_version";
            tableName: "uat_sessions";
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
        state: import("drizzle-orm/pg-core").PgColumn<{
            name: "state";
            tableName: "uat_sessions";
            dataType: "string";
            columnType: "PgText";
            data: "in_progress" | "accepted" | "rejected" | "started" | "submitted" | "partially_accepted";
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["started", "in_progress", "submitted", "accepted", "partially_accepted", "rejected"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        triggeredByEventId: import("drizzle-orm/pg-core").PgColumn<{
            name: "triggered_by_event_id";
            tableName: "uat_sessions";
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
        buildRef: import("drizzle-orm/pg-core").PgColumn<{
            name: "build_ref";
            tableName: "uat_sessions";
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
        startedByUserId: import("drizzle-orm/pg-core").PgColumn<{
            name: "started_by_user_id";
            tableName: "uat_sessions";
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
        startedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "started_at";
            tableName: "uat_sessions";
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
        submittedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "submitted_at";
            tableName: "uat_sessions";
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
        totalAcCount: import("drizzle-orm/pg-core").PgColumn<{
            name: "total_ac_count";
            tableName: "uat_sessions";
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
        passCount: import("drizzle-orm/pg-core").PgColumn<{
            name: "pass_count";
            tableName: "uat_sessions";
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
        failCount: import("drizzle-orm/pg-core").PgColumn<{
            name: "fail_count";
            tableName: "uat_sessions";
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
        outcomeNotes: import("drizzle-orm/pg-core").PgColumn<{
            name: "outcome_notes";
            tableName: "uat_sessions";
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
        assumptionsSnapshot: import("drizzle-orm/pg-core").PgColumn<{
            name: "assumptions_snapshot";
            tableName: "uat_sessions";
            dataType: "json";
            columnType: "PgJsonb";
            data: AssumptionItem[];
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
        schemaVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "schema_version";
            tableName: "uat_sessions";
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
export type UATSessionRow = typeof uatSessions.$inferSelect;
export type UATSessionInsert = typeof uatSessions.$inferInsert;
export interface AssumptionItem {
    assumption_id: string;
    source: 'vision' | 'worker';
    text: string;
    context?: string;
    recorded_by_persona_id?: string;
    recorded_at: string;
    task_id?: string;
}
/**
 * Per TRD-11 v0.2 §4.2.
 *
 * One row per AC per session. ac_text_snapshot is frozen at session start so
 * historical records remain stable even if the story is later re-decomposed.
 * UNIQUE (uat_session_id, ac_id) enforced via constraint.
 *
 * evidence_links: structured references to screenshots, logs, video, audit
 * events, or channel posts supporting the result.
 */
export declare const uatAcResults: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "uat_ac_results";
    schema: undefined;
    columns: {
        acResultId: import("drizzle-orm/pg-core").PgColumn<{
            name: "ac_result_id";
            tableName: "uat_ac_results";
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
        uatSessionId: import("drizzle-orm/pg-core").PgColumn<{
            name: "uat_session_id";
            tableName: "uat_ac_results";
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
        acId: import("drizzle-orm/pg-core").PgColumn<{
            name: "ac_id";
            tableName: "uat_ac_results";
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
        acOrdinal: import("drizzle-orm/pg-core").PgColumn<{
            name: "ac_ordinal";
            tableName: "uat_ac_results";
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
        acTextSnapshot: import("drizzle-orm/pg-core").PgColumn<{
            name: "ac_text_snapshot";
            tableName: "uat_ac_results";
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
            tableName: "uat_ac_results";
            dataType: "string";
            columnType: "PgText";
            data: "pass" | "fail" | "pending";
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["pending", "pass", "fail"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        observedBehavior: import("drizzle-orm/pg-core").PgColumn<{
            name: "observed_behavior";
            tableName: "uat_ac_results";
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
        evidenceLinks: import("drizzle-orm/pg-core").PgColumn<{
            name: "evidence_links";
            tableName: "uat_ac_results";
            dataType: "json";
            columnType: "PgJsonb";
            data: {
                type: "screenshot" | "log" | "video" | "audit_event" | "channel_post";
                uri: string;
                label?: string;
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
        markedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "marked_at";
            tableName: "uat_ac_results";
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
        markedByUserId: import("drizzle-orm/pg-core").PgColumn<{
            name: "marked_by_user_id";
            tableName: "uat_ac_results";
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
            tableName: "uat_ac_results";
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
export type UATACResultRow = typeof uatAcResults.$inferSelect;
export type UATACResultInsert = typeof uatAcResults.$inferInsert;
/**
 * Per TRD-11 v0.2 §4.3.
 *
 * One defect per failed AC (rationale in §8.1). eight-state lifecycle per §7.3.
 *
 * fixing_ticket_id: NULL until TRD-02 creates the fix story and populates this.
 * preempts_sprint: non-null sprint_id if this defect triggered sprint preemption.
 */
export declare const defects: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "defects";
    schema: undefined;
    columns: {
        defectId: import("drizzle-orm/pg-core").PgColumn<{
            name: "defect_id";
            tableName: "defects";
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
            tableName: "defects";
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
        defectKey: import("drizzle-orm/pg-core").PgColumn<{
            name: "defect_key";
            tableName: "defects";
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
        originStoryId: import("drizzle-orm/pg-core").PgColumn<{
            name: "origin_story_id";
            tableName: "defects";
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
        originAcId: import("drizzle-orm/pg-core").PgColumn<{
            name: "origin_ac_id";
            tableName: "defects";
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
        uatSessionId: import("drizzle-orm/pg-core").PgColumn<{
            name: "uat_session_id";
            tableName: "defects";
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
        acResultId: import("drizzle-orm/pg-core").PgColumn<{
            name: "ac_result_id";
            tableName: "defects";
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
        personaOfRecordId: import("drizzle-orm/pg-core").PgColumn<{
            name: "persona_of_record_id";
            tableName: "defects";
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
        title: import("drizzle-orm/pg-core").PgColumn<{
            name: "title";
            tableName: "defects";
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
        observedBehavior: import("drizzle-orm/pg-core").PgColumn<{
            name: "observed_behavior";
            tableName: "defects";
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
        expectedBehavior: import("drizzle-orm/pg-core").PgColumn<{
            name: "expected_behavior";
            tableName: "defects";
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
        severity: import("drizzle-orm/pg-core").PgColumn<{
            name: "severity";
            tableName: "defects";
            dataType: "string";
            columnType: "PgText";
            data: "critical" | "low" | "medium" | "high";
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["critical", "high", "medium", "low"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        state: import("drizzle-orm/pg-core").PgColumn<{
            name: "state";
            tableName: "defects";
            dataType: "string";
            columnType: "PgText";
            data: "in_progress" | "resolved" | "closed" | "open" | "triaged" | "assigned" | "verified" | "reopened";
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["open", "triaged", "assigned", "in_progress", "resolved", "verified", "reopened", "closed"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        preemptsSprint: import("drizzle-orm/pg-core").PgColumn<{
            name: "preempts_sprint";
            tableName: "defects";
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
            tableName: "defects";
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
        resolvedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "resolved_at";
            tableName: "defects";
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
        reopenCount: import("drizzle-orm/pg-core").PgColumn<{
            name: "reopen_count";
            tableName: "defects";
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
        fixingTicketId: import("drizzle-orm/pg-core").PgColumn<{
            name: "fixing_ticket_id";
            tableName: "defects";
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
        schemaVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "schema_version";
            tableName: "defects";
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
export type DefectRow = typeof defects.$inferSelect;
export type DefectInsert = typeof defects.$inferInsert;
/**
 * Per TRD-11 v0.2 §4.4.
 *
 * Materialised lineage breadcrumbs frozen at defect creation. One row per defect
 * (UNIQUE constraint). Preserves the vision→epic→story chain as it existed when
 * the defect was filed — upstream revisions do not affect historical records.
 */
export declare const defectLineage: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "defect_lineage";
    schema: undefined;
    columns: {
        defectLineageId: import("drizzle-orm/pg-core").PgColumn<{
            name: "defect_lineage_id";
            tableName: "defect_lineage";
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
        defectId: import("drizzle-orm/pg-core").PgColumn<{
            name: "defect_id";
            tableName: "defect_lineage";
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
        visionDocumentId: import("drizzle-orm/pg-core").PgColumn<{
            name: "vision_document_id";
            tableName: "defect_lineage";
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
        visionVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "vision_version";
            tableName: "defect_lineage";
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
        epicId: import("drizzle-orm/pg-core").PgColumn<{
            name: "epic_id";
            tableName: "defect_lineage";
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
        storyId: import("drizzle-orm/pg-core").PgColumn<{
            name: "story_id";
            tableName: "defect_lineage";
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
        ticketId: import("drizzle-orm/pg-core").PgColumn<{
            name: "ticket_id";
            tableName: "defect_lineage";
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
        taskIds: import("drizzle-orm/pg-core").PgColumn<{
            name: "task_ids";
            tableName: "defect_lineage";
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
        workerSessionIds: import("drizzle-orm/pg-core").PgColumn<{
            name: "worker_session_ids";
            tableName: "defect_lineage";
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
        primaryAuditEventIds: import("drizzle-orm/pg-core").PgColumn<{
            name: "primary_audit_event_ids";
            tableName: "defect_lineage";
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
        capturedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "captured_at";
            tableName: "defect_lineage";
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
            tableName: "defect_lineage";
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
export type DefectLineageRow = typeof defectLineage.$inferSelect;
export type DefectLineageInsert = typeof defectLineage.$inferInsert;
/**
 * Per TRD-11 v0.2 §4.5.
 *
 * Maps a story (via its tasks) to the persona that owned a piece of work.
 * Written by TRD-04 at task close; read by UAT defect creation.
 * The carry-forward algorithm (§8.2) is implemented in persona-of-record.ts.
 */
export declare const personaOfRecordLinks: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "persona_of_record_links";
    schema: undefined;
    columns: {
        porLinkId: import("drizzle-orm/pg-core").PgColumn<{
            name: "por_link_id";
            tableName: "persona_of_record_links";
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
        storyId: import("drizzle-orm/pg-core").PgColumn<{
            name: "story_id";
            tableName: "persona_of_record_links";
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
        acId: import("drizzle-orm/pg-core").PgColumn<{
            name: "ac_id";
            tableName: "persona_of_record_links";
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
        personaId: import("drizzle-orm/pg-core").PgColumn<{
            name: "persona_id";
            tableName: "persona_of_record_links";
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
        role: import("drizzle-orm/pg-core").PgColumn<{
            name: "role";
            tableName: "persona_of_record_links";
            dataType: "string";
            columnType: "PgText";
            data: "implementation" | "verification" | "review" | "tests" | "design" | "architecture";
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["implementation", "verification", "review", "tests", "design", "architecture"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        taskId: import("drizzle-orm/pg-core").PgColumn<{
            name: "task_id";
            tableName: "persona_of_record_links";
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
        workerSessionId: import("drizzle-orm/pg-core").PgColumn<{
            name: "worker_session_id";
            tableName: "persona_of_record_links";
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
        recordedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "recorded_at";
            tableName: "persona_of_record_links";
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
            tableName: "persona_of_record_links";
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
export type PersonaOfRecordLinkRow = typeof personaOfRecordLinks.$inferSelect;
export type PersonaOfRecordLinkInsert = typeof personaOfRecordLinks.$inferInsert;
//# sourceMappingURL=uat.d.ts.map