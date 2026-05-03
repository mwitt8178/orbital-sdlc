/**
 * ac-check-evidence.ts — Drizzle schema for the per-AC verifier evidence table.
 *
 * Per Round 5C spec and architecture.md:
 *   audit.ac_check_evidence — one row per AC checked by the verifier.
 *
 * The verifier writes one row per AC during a verification run. The UAT UI
 * reads the most recent evidence for an AC via `uat.ac.evidence` (joining on
 * ac_id, ORDER BY created_at DESC, LIMIT 1).
 *
 * Logical FKs (no physical FK, per DSQL hard-no list):
 *   - verification_id → verifications.verification_id (TRD-09 §4.4)
 *   - ac_id           → story_acceptance_criteria.ac_id (TRD-02 §4.1)
 *
 * Mutability:
 *   - INSERT-only at the application layer; rows are immutable evidence.
 *   - No DB-level append-only trigger (the audit.events table has one; this
 *     is a softer constraint for evidence rows because re-verification
 *     intentionally writes new rows rather than mutating old ones).
 */
export declare const AC_EVIDENCE_RESULT: readonly ["pass", "fail", "ambiguous"];
export type ACEvidenceResult = (typeof AC_EVIDENCE_RESULT)[number];
export declare const AC_EVIDENCE_KIND: readonly ["test_run", "static_analysis", "llm_inspection", "manual_required", "ci_run"];
export type ACEvidenceKind = (typeof AC_EVIDENCE_KIND)[number];
export declare const CI_CONCLUSION: readonly ["success", "failure", "cancelled", "skipped", "timed_out", "neutral", "action_required"];
export type CIConclusion = (typeof CI_CONCLUSION)[number];
export declare const acCheckEvidence: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "ac_check_evidence";
    schema: "audit";
    columns: {
        evidenceId: import("drizzle-orm/pg-core").PgColumn<{
            name: "evidence_id";
            tableName: "ac_check_evidence";
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
        verificationId: import("drizzle-orm/pg-core").PgColumn<{
            name: "verification_id";
            tableName: "ac_check_evidence";
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
            tableName: "ac_check_evidence";
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
        result: import("drizzle-orm/pg-core").PgColumn<{
            name: "result";
            tableName: "ac_check_evidence";
            dataType: "string";
            columnType: "PgText";
            data: "pass" | "fail" | "ambiguous";
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["pass", "fail", "ambiguous"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        evidenceKind: import("drizzle-orm/pg-core").PgColumn<{
            name: "evidence_kind";
            tableName: "ac_check_evidence";
            dataType: "string";
            columnType: "PgText";
            data: "test_run" | "static_analysis" | "llm_inspection" | "manual_required" | "ci_run";
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["test_run", "static_analysis", "llm_inspection", "manual_required", "ci_run"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        testCommand: import("drizzle-orm/pg-core").PgColumn<{
            name: "test_command";
            tableName: "ac_check_evidence";
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
        testOutput: import("drizzle-orm/pg-core").PgColumn<{
            name: "test_output";
            tableName: "ac_check_evidence";
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
        testExitCode: import("drizzle-orm/pg-core").PgColumn<{
            name: "test_exit_code";
            tableName: "ac_check_evidence";
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
        llmReasoning: import("drizzle-orm/pg-core").PgColumn<{
            name: "llm_reasoning";
            tableName: "ac_check_evidence";
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
        ciRunUrl: import("drizzle-orm/pg-core").PgColumn<{
            name: "ci_run_url";
            tableName: "ac_check_evidence";
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
        ciCheckName: import("drizzle-orm/pg-core").PgColumn<{
            name: "ci_check_name";
            tableName: "ac_check_evidence";
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
        ciConclusion: import("drizzle-orm/pg-core").PgColumn<{
            name: "ci_conclusion";
            tableName: "ac_check_evidence";
            dataType: "string";
            columnType: "PgText";
            data: "success" | "failure" | "cancelled" | "skipped" | "timed_out" | "neutral" | "action_required";
            driverParam: string;
            notNull: false;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["success", "failure", "cancelled", "skipped", "timed_out", "neutral", "action_required"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        filesInspected: import("drizzle-orm/pg-core").PgColumn<{
            name: "files_inspected";
            tableName: "ac_check_evidence";
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
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "ac_check_evidence";
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
    };
    dialect: "pg";
}>;
export type ACCheckEvidenceRow = typeof acCheckEvidence.$inferSelect;
export type ACCheckEvidenceInsert = typeof acCheckEvidence.$inferInsert;
//# sourceMappingURL=ac-check-evidence.d.ts.map