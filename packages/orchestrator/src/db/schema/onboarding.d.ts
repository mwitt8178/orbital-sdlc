/**
 * onboarding.ts — Drizzle schema for the resumable onboarding wizard.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * One row per in-flight or completed onboarding session. Persisting state
 * server-side (rather than in browser local storage) is what makes the wizard
 * resumable: refresh mid-flow returns to the same step with the same data.
 *
 * Multi-tenant-isolation: every row carries `tenant_id`; sentinel
 * '00000000-0000-0000-0000-000000000000' = local-install default.
 *
 * No FKs (DSQL constraint); cross-context references (project_id, install_id)
 * are nullable uuid columns per TRD-01 §4.5.
 */
export declare const onboardingSessions: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "onboarding_sessions";
    schema: undefined;
    columns: {
        sessionId: import("drizzle-orm/pg-core").PgColumn<{
            name: "session_id";
            tableName: "onboarding_sessions";
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
            tableName: "onboarding_sessions";
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
        installId: import("drizzle-orm/pg-core").PgColumn<{
            name: "install_id";
            tableName: "onboarding_sessions";
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
        flow: import("drizzle-orm/pg-core").PgColumn<{
            name: "flow";
            tableName: "onboarding_sessions";
            dataType: "string";
            columnType: "PgText";
            data: "new_project" | "existing_repo" | "join_hub" | "sample_data";
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["new_project", "existing_repo", "join_hub", "sample_data"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        currentStep: import("drizzle-orm/pg-core").PgColumn<{
            name: "current_step";
            tableName: "onboarding_sessions";
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
            tableName: "onboarding_sessions";
            dataType: "string";
            columnType: "PgText";
            data: "active" | "completed" | "abandoned";
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["active", "completed", "abandoned"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        stateJson: import("drizzle-orm/pg-core").PgColumn<{
            name: "state_json";
            tableName: "onboarding_sessions";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
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
        projectId: import("drizzle-orm/pg-core").PgColumn<{
            name: "project_id";
            tableName: "onboarding_sessions";
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
        stepDurations: import("drizzle-orm/pg-core").PgColumn<{
            name: "step_durations";
            tableName: "onboarding_sessions";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
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
        stepStartedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "step_started_at";
            tableName: "onboarding_sessions";
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
        startedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "started_at";
            tableName: "onboarding_sessions";
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
        completedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "completed_at";
            tableName: "onboarding_sessions";
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
        abandonedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "abandoned_at";
            tableName: "onboarding_sessions";
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
        updatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "updated_at";
            tableName: "onboarding_sessions";
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
            tableName: "onboarding_sessions";
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
export type OnboardingSessionRow = typeof onboardingSessions.$inferSelect;
export type OnboardingSessionInsert = typeof onboardingSessions.$inferInsert;
//# sourceMappingURL=onboarding.d.ts.map