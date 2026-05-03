/**
 * board-mapping.ts — Drizzle schema for Round 5 board discovery + mapping.
 *
 * Per Round 5 Monday Board Discovery spec.
 *
 * The integration goal is to learn from each project's existing Monday board
 * shape, instead of pushing a fixed canonical schema. Two new tables:
 *
 *   - board_schemas — the introspected shape of a Monday board. Keyed on
 *     board_id; one row per board. Updated on every discover() call.
 *   - board_mappings — the canonical-to-board mapping a user (or LLM) has
 *     proposed/confirmed for a project. Keyed on (project_id, board_id) with
 *     unique index. confirmed_at IS NOT NULL means the personas should use
 *     this mapping; rows with confirmed_at IS NULL are pending proposals.
 *
 * No FKs — cross-context references (project_id) follow the TRD-01 §4.5
 * nullable uuid convention. No triggers, sequences, materialized views — all
 * DSQL-portable.
 *
 * The mapping_json blob is the BoardMapping shape from board-mapping.ts. We
 * store it as jsonb for flexibility while the API is iterated; once the
 * schema_version is locked, columns can be promoted to first-class fields.
 */
export declare const boardSchemas: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "board_schemas";
    schema: undefined;
    columns: {
        boardId: import("drizzle-orm/pg-core").PgColumn<{
            name: "board_id";
            tableName: "board_schemas";
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
        schemaJson: import("drizzle-orm/pg-core").PgColumn<{
            name: "schema_json";
            tableName: "board_schemas";
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
        mondayApiVersion: import("drizzle-orm/pg-core").PgColumn<{
            name: "monday_api_version";
            tableName: "board_schemas";
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
        discoveredAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "discovered_at";
            tableName: "board_schemas";
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
            tableName: "board_schemas";
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
export type BoardSchemaRow = typeof boardSchemas.$inferSelect;
export type BoardSchemaInsert = typeof boardSchemas.$inferInsert;
export declare const boardMappings: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "board_mappings";
    schema: undefined;
    columns: {
        mappingId: import("drizzle-orm/pg-core").PgColumn<{
            name: "mapping_id";
            tableName: "board_mappings";
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
        projectId: import("drizzle-orm/pg-core").PgColumn<{
            name: "project_id";
            tableName: "board_mappings";
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
        boardId: import("drizzle-orm/pg-core").PgColumn<{
            name: "board_id";
            tableName: "board_mappings";
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
        mappingJson: import("drizzle-orm/pg-core").PgColumn<{
            name: "mapping_json";
            tableName: "board_mappings";
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
        proposedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "proposed_at";
            tableName: "board_mappings";
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
        confirmedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "confirmed_at";
            tableName: "board_mappings";
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
        confirmedBy: import("drizzle-orm/pg-core").PgColumn<{
            name: "confirmed_by";
            tableName: "board_mappings";
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
            tableName: "board_mappings";
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
export type BoardMappingRow = typeof boardMappings.$inferSelect;
export type BoardMappingInsert = typeof boardMappings.$inferInsert;
//# sourceMappingURL=board-mapping.d.ts.map