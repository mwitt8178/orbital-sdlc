import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
/**
 * Synchronous Postgres client.
 * Valid in local/Docker mode (ORBITAL_DEPLOY_TARGET unset).
 * In AWS mode use `getDb()` instead.
 */
export declare const sql: postgres.Sql;
/**
 * Synchronous Drizzle DB client.
 * Valid in local/Docker mode (ORBITAL_DEPLOY_TARGET unset).
 * In AWS mode use `getDb()` instead.
 */
export declare const db: ReturnType<typeof drizzle>;
export type DB = typeof db;
/**
 * getDb — async accessor that works in both local and AWS mode.
 *
 * In local/Docker mode: returns the pre-built synchronous client immediately.
 * In AWS mode:          generates an IAM token, builds the client, and returns it.
 *
 * AWS Lambda handlers should call this once per cold start and cache the result
 * in module scope:
 *
 *   let dbInstance: Awaited<ReturnType<typeof getDb>> | null = null
 *
 *   export async function handler(event) {
 *     if (!dbInstance) dbInstance = await getDb()
 *     const { db } = dbInstance
 *     // ... use db
 *   }
 */
export declare function getDb(): Promise<{
    sql: postgres.Sql;
    db: ReturnType<typeof drizzle>;
}>;
/**
 * Cleanly close the pool.
 * In AWS Lambda, call this in the SIGTERM handler (Lambda shutdown lifecycle).
 */
export declare function closeDb(): Promise<void>;
//# sourceMappingURL=client.d.ts.map