/**
 * known-installs.ts — Drizzle schema for hub-side install registry.
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Each row represents one laptop (install) paired with the hub. The hub uses
 * `public_key` to verify Ed25519 signatures on every inbound request from
 * that install. `revoked_at IS NOT NULL` is the kill switch.
 *
 * Per multi-tenant-isolation: every row carries `tenant_id`. Hub registration
 * stamps the tenant from the invite JWT.
 *
 * Per multi-tenant-migrations: this table is additive. No FKs, no triggers,
 * no sequences. UUIDv7 install_id from the application layer.
 *
 * Per DSQL constraints: no foreign keys to other tables (install_id is opaque
 * to other aggregates). Indexes added directly in the migration; no sequences.
 *
 * `invite_jti` enforces single-use invite tokens via a UNIQUE INDEX. The first
 * registration consumes the jti; subsequent attempts to reuse the same invite
 * fail with a unique-constraint violation that the registration handler maps
 * to AUTH_INVITE_ALREADY_USED.
 */
export declare const knownInstalls: import("drizzle-orm/pg-core").PgTableWithColumns<{
    name: "known_installs";
    schema: undefined;
    columns: {
        install_id: import("drizzle-orm/pg-core").PgColumn<{
            name: "install_id";
            tableName: "known_installs";
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
        tenant_id: import("drizzle-orm/pg-core").PgColumn<{
            name: "tenant_id";
            tableName: "known_installs";
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
        public_key: import("drizzle-orm/pg-core").PgColumn<{
            name: "public_key";
            tableName: "known_installs";
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
            tableName: "known_installs";
            dataType: "string";
            columnType: "PgText";
            data: "owner" | "member" | "viewer";
            driverParam: string;
            notNull: true;
            hasDefault: false;
            isPrimaryKey: false;
            isAutoincrement: false;
            hasRuntimeDefault: false;
            enumValues: ["owner", "member", "viewer"];
            baseColumn: never;
            identity: undefined;
            generated: undefined;
        }, {}, {}>;
        display_name: import("drizzle-orm/pg-core").PgColumn<{
            name: "display_name";
            tableName: "known_installs";
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
        invite_jti: import("drizzle-orm/pg-core").PgColumn<{
            name: "invite_jti";
            tableName: "known_installs";
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
        joined_at: import("drizzle-orm/pg-core").PgColumn<{
            name: "joined_at";
            tableName: "known_installs";
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
        last_seen_at: import("drizzle-orm/pg-core").PgColumn<{
            name: "last_seen_at";
            tableName: "known_installs";
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
        revoked_at: import("drizzle-orm/pg-core").PgColumn<{
            name: "revoked_at";
            tableName: "known_installs";
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
    };
    dialect: "pg";
}>;
export type KnownInstallRow = typeof knownInstalls.$inferSelect;
export type KnownInstallInsert = typeof knownInstalls.$inferInsert;
//# sourceMappingURL=known-installs.d.ts.map