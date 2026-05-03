/**
 * Drizzle schemas for drift_events, reconciliation_runs, and audit_query_cache.
 *
 * Per TRD-07 §4.2 and §4.3. Service logic (reconciliation algorithm, query
 * cache population) is owned by Phase 4C; these are schema stubs only.
 *
 * Unlike audit.events, drift_events IS mutable (resolution fields are updated).
 * It does NOT carry the append-only trigger.
 */
export declare const audit: import("drizzle-orm/pg-core").PgSchema<"audit">;
/**
 * One row per reconciliation run (scheduled or on-demand).
 * Status transitions: running → completed | failed.
 * Concurrency enforced by pg_try_advisory_lock per TRD-07 §7.6.
 */
export declare const reconciliationRuns: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "reconciliation_runs";
    schema: "audit";
    columns: {
        runId: import("drizzle-orm/pg-core").PgColumn<{
            name: "run_id";
            tableName: "reconciliation_runs";
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
        startedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "started_at";
            tableName: "reconciliation_runs";
            dataType: "string";
            columnType: "PgTimestampString";
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
        completedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "completed_at";
            tableName: "reconciliation_runs";
            dataType: "string";
            columnType: "PgTimestampString";
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
        trigger: import("drizzle-orm/pg-core").PgColumn<{
            name: "trigger";
            tableName: "reconciliation_runs";
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
        triggeredBy: import("drizzle-orm/pg-core").PgColumn<{
            name: "triggered_by";
            tableName: "reconciliation_runs";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
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
        windowFrom: import("drizzle-orm/pg-core").PgColumn<{
            name: "window_from";
            tableName: "reconciliation_runs";
            dataType: "string";
            columnType: "PgTimestampString";
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
        windowTo: import("drizzle-orm/pg-core").PgColumn<{
            name: "window_to";
            tableName: "reconciliation_runs";
            dataType: "string";
            columnType: "PgTimestampString";
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
        gitCommitsScanned: import("drizzle-orm/pg-core").PgColumn<{
            name: "git_commits_scanned";
            tableName: "reconciliation_runs";
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
        worktreeFilesScanned: import("drizzle-orm/pg-core").PgColumn<{
            name: "worktree_files_scanned";
            tableName: "reconciliation_runs";
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
        mondayItemsScanned: import("drizzle-orm/pg-core").PgColumn<{
            name: "monday_items_scanned";
            tableName: "reconciliation_runs";
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
        driftEventsEmitted: import("drizzle-orm/pg-core").PgColumn<{
            name: "drift_events_emitted";
            tableName: "reconciliation_runs";
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
        status: import("drizzle-orm/pg-core").PgColumn<{
            name: "status";
            tableName: "reconciliation_runs";
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
        errorPayload: import("drizzle-orm/pg-core").PgColumn<{
            name: "error_payload";
            tableName: "reconciliation_runs";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
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
    };
    dialect: "pg";
}>;
export type ReconciliationRunRow = typeof reconciliationRuns.$inferSelect;
export type ReconciliationRunInsert = typeof reconciliationRuns.$inferInsert;
/**
 * One row per detected drift instance.
 * Mutable: resolution / resolutionNote / resolvedAt are updated by operator.
 * The durable record lives in audit.events (DriftDetected); this table is the index.
 */
export declare const driftEvents: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "drift_events";
    schema: "audit";
    columns: {
        driftId: import("drizzle-orm/pg-core").PgColumn<{
            name: "drift_id";
            tableName: "drift_events";
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
        runId: import("drizzle-orm/pg-core").PgColumn<{
            name: "run_id";
            tableName: "drift_events";
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
        source: import("drizzle-orm/pg-core").PgColumn<{
            name: "source";
            tableName: "drift_events";
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
        driftKind: import("drizzle-orm/pg-core").PgColumn<{
            name: "drift_kind";
            tableName: "drift_events";
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
        observed: import("drizzle-orm/pg-core").PgColumn<{
            name: "observed";
            tableName: "drift_events";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
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
        expected: import("drizzle-orm/pg-core").PgColumn<{
            name: "expected";
            tableName: "drift_events";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
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
        severity: import("drizzle-orm/pg-core").PgColumn<{
            name: "severity";
            tableName: "drift_events";
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
        detectedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "detected_at";
            tableName: "drift_events";
            dataType: "string";
            columnType: "PgTimestampString";
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
        detectionEventId: import("drizzle-orm/pg-core").PgColumn<{
            name: "detection_event_id";
            tableName: "drift_events";
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
        resolution: import("drizzle-orm/pg-core").PgColumn<{
            name: "resolution";
            tableName: "drift_events";
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
        resolutionNote: import("drizzle-orm/pg-core").PgColumn<{
            name: "resolution_note";
            tableName: "drift_events";
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
        resolvedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "resolved_at";
            tableName: "drift_events";
            dataType: "string";
            columnType: "PgTimestampString";
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
    };
    dialect: "pg";
}>;
export type DriftEventRow = typeof driftEvents.$inferSelect;
export type DriftEventInsert = typeof driftEvents.$inferInsert;
/**
 * Optional cache for high-cost recurring queries.
 * Population and TTL strategy are deferred per TRD-07 §13 Q-7-2.
 * Flag: ORBITAL_AUDIT_QUERY_CACHE=on enables the lookup path.
 */
export declare const auditQueryCache: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "audit_query_cache";
    schema: "audit";
    columns: {
        cacheKey: import("drizzle-orm/pg-core").PgColumn<{
            name: "cache_key";
            tableName: "audit_query_cache";
            dataType: "string";
            columnType: "PgText";
            data: string;
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: [string, ...string[]];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        resultPage: import("drizzle-orm/pg-core").PgColumn<{
            name: "result_page";
            tableName: "audit_query_cache";
            dataType: "json";
            columnType: "PgJsonb";
            data: unknown;
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
        totalEstimate: import("drizzle-orm/pg-core").PgColumn<{
            name: "total_estimate";
            tableName: "audit_query_cache";
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
        populatedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "populated_at";
            tableName: "audit_query_cache";
            dataType: "string";
            columnType: "PgTimestampString";
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
        expiresAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "expires_at";
            tableName: "audit_query_cache";
            dataType: "string";
            columnType: "PgTimestampString";
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
        hitCount: import("drizzle-orm/pg-core").PgColumn<{
            name: "hit_count";
            tableName: "audit_query_cache";
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
export type AuditQueryCacheRow = typeof auditQueryCache.$inferSelect;
export type AuditQueryCacheInsert = typeof auditQueryCache.$inferInsert;
//# sourceMappingURL=audit.d.ts.map