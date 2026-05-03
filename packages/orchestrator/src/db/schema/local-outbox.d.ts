/**
 * local-outbox.ts — Drizzle schema for the local_outbox table.
 *
 * Round 7-06 — Offline Cache + Reconciliation
 * [Engineer-Sr · Sonnet · run-round7-06-offline-reconcile]
 *
 * local_outbox is a LOCAL-ONLY table (not shared to the hub).
 * It persists hub-bound mutations and events when the hub is unreachable,
 * enabling ordered flush-on-reconnect with idempotency guarantees.
 *
 * Schema design:
 *   - seq: bigserial surrogate PK — drives strict flush ordering
 *   - kind: 'event' | 'mutation' — determines which hub endpoint receives the row
 *   - endpoint: tRPC procedure path, e.g. 'audit.events.append', 'tasks.claim'
 *   - payload: the full JSON body to send
 *   - idempotency_key: UUID generated at enqueue time; hub deduplicates within 24h
 *   - created_at: wall-clock enqueue time
 *   - attempts: incremented on each flush attempt; used for backoff
 *   - last_error: last error message for observability + UI
 *   - flushed_at: set when hub confirmed receipt; NULL = pending
 *
 * Per DSQL constraints:
 *   - No foreign keys
 *   - No triggers
 *   - No extensions
 *   - IDs generated in application layer
 *
 * Per multi-tenant-migrations: additive-only, CREATE TABLE IF NOT EXISTS.
 */
export declare const localOutbox: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "local_outbox";
    schema: undefined;
    columns: {
        seq: import("drizzle-orm/pg-core").PgColumn<{
            name: "seq";
            tableName: "local_outbox";
            dataType: "bigint";
            columnType: "PgBigSerial64";
            data: bigint;
            driverParam: string;
            notNull: true;
            hasDefault: true;
            isPrimaryKey: true;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: undefined;
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        kind: import("drizzle-orm/pg-core").PgColumn<{
            name: "kind";
            tableName: "local_outbox";
            dataType: "string";
            columnType: "PgText";
            data: "event" | "mutation";
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["event", "mutation"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        endpoint: import("drizzle-orm/pg-core").PgColumn<{
            name: "endpoint";
            tableName: "local_outbox";
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
        payload: import("drizzle-orm/pg-core").PgColumn<{
            name: "payload";
            tableName: "local_outbox";
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
        idempotency_key: import("drizzle-orm/pg-core").PgColumn<{
            name: "idempotency_key";
            tableName: "local_outbox";
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
        created_at: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "local_outbox";
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
        attempts: import("drizzle-orm/pg-core").PgColumn<{
            name: "attempts";
            tableName: "local_outbox";
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
        last_error: import("drizzle-orm/pg-core").PgColumn<{
            name: "last_error";
            tableName: "local_outbox";
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
        flushed_at: import("drizzle-orm/pg-core").PgColumn<{
            name: "flushed_at";
            tableName: "local_outbox";
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
export type LocalOutboxRow = typeof localOutbox.$inferSelect;
export type LocalOutboxInsert = typeof localOutbox.$inferInsert;
//# sourceMappingURL=local-outbox.d.ts.map