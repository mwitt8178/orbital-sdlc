/**
 * Drizzle schema for the audit.mutation_idempotency table.
 *
 * Round 3 Security Hardening — Gap S5 (idempotent tRPC mutations).
 *
 * Stores the cached response for a (idempotency_key, route) pair so that a
 * client retry of a timed-out mutation returns the original response (or
 * original error) rather than re-executing the mutation and producing
 * duplicate domain events.
 *
 * Constraints (DSQL hard-no list, see CLAUDE.md):
 *   - No FK to other tables.
 *   - No trigger.
 *   - No SERIAL — composite PK is application-supplied text.
 *   - No materialized view.
 *
 * TTL is enforced at read time (`expires_at > now()`); a periodic cleanup is
 * a future ops task — stale rows are functionally inert because the read
 * predicate excludes them.
 */
export declare const mutationIdempotency: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "mutation_idempotency";
    schema: "audit";
    columns: {
        idempotencyKey: import("drizzle-orm/pg-core").PgColumn<{
            name: "idempotency_key";
            tableName: "mutation_idempotency";
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
        route: import("drizzle-orm/pg-core").PgColumn<{
            name: "route";
            tableName: "mutation_idempotency";
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
            tableName: "mutation_idempotency";
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
        responseJson: import("drizzle-orm/pg-core").PgColumn<{
            name: "response_json";
            tableName: "mutation_idempotency";
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
        createdAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "created_at";
            tableName: "mutation_idempotency";
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
            tableName: "mutation_idempotency";
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
    };
    dialect: "pg";
}>;
export type MutationIdempotencyRow = typeof mutationIdempotency.$inferSelect;
export type MutationIdempotencyInsert = typeof mutationIdempotency.$inferInsert;
//# sourceMappingURL=idempotency.d.ts.map