/**
 * Phase 3.2 re-export shim.
 * The real implementation has moved to @orbital/db (packages/db/src/client.ts).
 * This file preserves backward-compat for the ~216 internal orchestrator imports
 * that still use the `../db/client.js` relative path.
 *
 * Phase 3.6 boundary lint will eventually flag these; migrate them over time.
 */
export { getDb, closeDb, sql, db } from '@orbital/db';
export type { DB } from '@orbital/db';
//# sourceMappingURL=client.d.ts.map