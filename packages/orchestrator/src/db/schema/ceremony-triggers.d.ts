/**
 * ceremony-triggers.ts — Drizzle schema for the agent-native CeremonyScheduler
 * dedupe log.
 *
 * The CeremonyScheduler subscribes to the EventStore and matches each envelope
 * against a registry of CeremonyTriggerRule instances. To make rule firings
 * exactly-once with respect to the trigger envelope, we use the natural-key
 * pair (rule_id, trigger_event_id) as the primary key. INSERT...ON CONFLICT
 * DO NOTHING gives atomic claim semantics: only the first insert succeeds, all
 * others (subscriber redelivery, multi-process boot, retries) become no-ops.
 *
 * No FKs (DSQL constraint compatibility); rule_id is a free-form text id for
 * forward compatibility (rules are code-defined, not row-defined).
 *
 * Table is owned by the comms context. Companion migration: 0017_ceremony_triggers.sql.
 */
export declare const ceremonyTriggerFirings: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "ceremony_trigger_firings";
    schema: undefined;
    columns: {
        ruleId: import("drizzle-orm/pg-core").PgColumn<{
            name: "rule_id";
            tableName: "ceremony_trigger_firings";
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
        triggerEventId: import("drizzle-orm/pg-core").PgColumn<{
            name: "trigger_event_id";
            tableName: "ceremony_trigger_firings";
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
        firedAt: import("drizzle-orm/pg-core").PgColumn<{
            name: "fired_at";
            tableName: "ceremony_trigger_firings";
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
        ceremonyId: import("drizzle-orm/pg-core").PgColumn<{
            name: "ceremony_id";
            tableName: "ceremony_trigger_firings";
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
    };
    dialect: "pg";
}>;
export type CeremonyTriggerFiringRow = typeof ceremonyTriggerFirings.$inferSelect;
export type CeremonyTriggerFiringInsert = typeof ceremonyTriggerFirings.$inferInsert;
//# sourceMappingURL=ceremony-triggers.d.ts.map