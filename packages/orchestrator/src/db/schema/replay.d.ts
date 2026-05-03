/**
 * replay.ts — Drizzle schema for the replay_captures table.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * Per Round 6 Task #7 (Determinism / Replay) architecture.md.
 *
 * Each row is metadata describing one capture (LLM request, tool call, or
 * hook invocation). The full request+response blob is stored at storage_uri
 * (filesystem v1; S3 later — abstracted via replay/store.ts). The
 * request_hash + response_hash columns are sha256 of the canonical JSON;
 * replay reads verify integrity by recomputing the hashes on the decrypted
 * blob.
 *
 * No physical FKs — DSQL constraints prohibit them. Logical relations:
 *   worker_id → orchestration.workers.worker_id
 *   task_id   → orchestration.tasks.task_id
 *   event_id  → audit.events.event_id (the audit event this capture "belongs to")
 */
export declare const replayCaptures: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "replay_captures";
    schema: undefined;
    columns: {
        captureId: import("drizzle-orm/pg-core").PgColumn<{
            name: "capture_id";
            tableName: "replay_captures";
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
        occurredAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "occurred_at";
            tableName: "replay_captures";
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
        workerId: import("drizzle-orm/pg-core").PgColumn<{
            name: "worker_id";
            tableName: "replay_captures";
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
        taskId: import("drizzle-orm/pg-core").PgColumn<{
            name: "task_id";
            tableName: "replay_captures";
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
        eventId: import("drizzle-orm/pg-core").PgColumn<{
            name: "event_id";
            tableName: "replay_captures";
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
        captureKind: import("drizzle-orm/pg-core").PgColumn<{
            name: "capture_kind";
            tableName: "replay_captures";
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
        provider: import("drizzle-orm/pg-core").PgColumn<{
            name: "provider";
            tableName: "replay_captures";
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
        model: import("drizzle-orm/pg-core").PgColumn<{
            name: "model";
            tableName: "replay_captures";
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
        requestHash: import("drizzle-orm/pg-core").PgColumn<{
            name: "request_hash";
            tableName: "replay_captures";
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
        responseHash: import("drizzle-orm/pg-core").PgColumn<{
            name: "response_hash";
            tableName: "replay_captures";
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
        storageUri: import("drizzle-orm/pg-core").PgColumn<{
            name: "storage_uri";
            tableName: "replay_captures";
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
        sizeBytes: import("drizzle-orm/pg-core").PgColumn<{
            name: "size_bytes";
            tableName: "replay_captures";
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
        schemaVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "schema_version";
            tableName: "replay_captures";
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
export type ReplayCaptureRow = typeof replayCaptures.$inferSelect;
export type ReplayCaptureInsert = typeof replayCaptures.$inferInsert;
//# sourceMappingURL=replay.d.ts.map