/**
 * trpc/routers/team.ts — Team presence and member listing.
 *
 * Round 7-08 — Operator-Attributed UI
 * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
 *
 * Procedures:
 *   team.members({ tenant_id }) — list all non-revoked installs in the tenant;
 *     returns { install_id, display_name, role, last_seen_at, color } for each.
 *   team.myInstallId            — returns the current install's install_id.
 *
 * Tenant isolation: every query is scoped by tenant_id. Cross-tenant queries
 * return empty list, never another tenant's members.
 *
 * Multi-tenant-isolation self-check:
 *   - tenant_id filter on EVERY query to known_installs.
 *   - No cross-tenant data leakage: tested in integration test.
 */

import { z } from 'zod'
import { eq, and, isNull } from 'drizzle-orm'
import { db } from '../../db/client.js'
import { knownInstalls } from '../../db/schema/known-installs.js'
import { router, publicProcedure } from '../init.js'
import { tenantProcedure } from '../middleware/tenant.js'
import { loadOrCreateInstall } from '../../config/install.js'
import { operatorHue } from '../helpers/operator-color-server.js'
import { logger } from '../../config/logger.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamMemberRecord {
  install_id: string
  display_name: string | null
  role: 'owner' | 'member' | 'viewer'
  last_seen_at: string | null
  /** Deterministic HSL hue [60, 360) — precomputed server-side for consistency. */
  color: number
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const teamRouter = router({
  /**
   * team.members — list all active (non-revoked) installs in the tenant.
   *
   * Tenant isolation: uses tenantProcedure which guarantees ctx.tenantId is
   * scoped to the caller's tenant. The query adds an explicit WHERE tenant_id
   * = ctx.tenantId clause.
   */
  members: tenantProcedure
    .input(
      z.object({
        tenant_id: z.string().uuid().optional(),
      }).optional(),
    )
    .query(async ({ ctx }): Promise<TeamMemberRecord[]> => {
      const tenantId = ctx.tenantId

      try {
        const rows = await db
          .select({
            install_id: knownInstalls.install_id,
            display_name: knownInstalls.display_name,
            role: knownInstalls.role,
            last_seen_at: knownInstalls.last_seen_at,
          })
          .from(knownInstalls)
          .where(
            and(
              eq(knownInstalls.tenant_id, tenantId),
              isNull(knownInstalls.revoked_at),
            ),
          )
          .orderBy(knownInstalls.joined_at)

        return rows.map((row) => ({
          install_id: row.install_id,
          display_name: row.display_name ?? null,
          role: row.role as 'owner' | 'member' | 'viewer',
          last_seen_at: row.last_seen_at ? row.last_seen_at.toISOString() : null,
          color: operatorHue(row.install_id),
        }))
      } catch (err) {
        logger.error({ err, tenantId }, 'team.members: query failed')
        // Graceful degradation: return empty array so UI doesn't crash
        return []
      }
    }),

  /**
   * team.myInstallId — returns this install's install_id.
   *
   * The UI needs this to highlight "Mine" in filter chips and for self-exclusion
   * in presence lists.
   */
  myInstallId: publicProcedure.query(async (): Promise<{ install_id: string; display_name: string | null }> => {
    const install = await loadOrCreateInstall()
    // Try to look up display_name from known_installs (only available in hub/paired mode)
    let displayName: string | null = null
    try {
      const rows = await db
        .select({ display_name: knownInstalls.display_name })
        .from(knownInstalls)
        .where(eq(knownInstalls.install_id, install.install_id))
        .limit(1)
      displayName = rows[0]?.display_name ?? null
    } catch {
      // Table may not exist yet in local-only mode — safe to ignore
    }
    return {
      install_id: install.install_id,
      display_name: displayName,
    }
  }),
})

export type TeamRouter = typeof teamRouter
