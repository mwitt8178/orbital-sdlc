/**
 * trpc/routers/team.ts — Team presence + per-project team management.
 *
 * [Engineer-Principal · Opus · run-feat-settings-team]
 *
 * Read procedures (existing):
 *   team.members({ tenant_id })  — list installs in the tenant (presence)
 *   team.myInstallId             — current install id
 *
 * Per-project management (new):
 *   team.list({ projectId })            — members + invites + status
 *   team.invite({ projectId, email, role })
 *   team.changeRole({ projectId, userId, role })
 *   team.remove({ projectId, userId })
 *   team.resendInvite({ inviteId })
 *   team.revokeInvite({ inviteId })
 *   team.audit({ projectId, eventType?, limit? })
 *   team.addExisting({ projectId, email, role, cognitoSub? })
 *
 * Tenant isolation is enforced by:
 *   - tenantProcedure injecting ctx.tenantId
 *   - team service verifying project belongs to that tenant before any write
 */

import { z } from 'zod'
import { eq, and, isNull } from 'drizzle-orm'
import { TRPCError } from '@trpc/server'
import { db } from '../../db/client.js'
import { knownInstalls } from '../../db/schema/known-installs.js'
import { router, publicProcedure } from '../init.js'
import { tenantProcedure } from '../middleware/tenant.js'
import { loadOrCreateInstall } from '../../config/install.js'
import { operatorHue } from '../helpers/operator-color-server.js'
import { logger } from '../../config/logger.js'
import {
  listMembers,
  listInvites,
  listAudit,
  inviteMember,
  changeRole,
  removeMember,
  resendInvite,
  revokeInvite,
  addExistingMember,
} from '../../team/service.js'
import { readCognitoEnv } from '../../team/cognito-client.js'

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

const RoleEnum = z.enum(['admin', 'member', 'viewer'])
const EventTypeEnum = z.enum([
  'member_invited',
  'member_added',
  'member_role_changed',
  'member_removed',
  'invite_resent',
  'invite_revoked',
])

function trpcError(err: unknown): never {
  const e = err as Error & { code?: string }
  const map: Record<string, 'NOT_FOUND' | 'CONFLICT' | 'BAD_REQUEST' | 'INTERNAL_SERVER_ERROR'> = {
    NOT_FOUND: 'NOT_FOUND',
    CONFLICT: 'CONFLICT',
    BAD_REQUEST: 'BAD_REQUEST',
  }
  const code = (e.code && map[e.code]) || 'INTERNAL_SERVER_ERROR'
  throw new TRPCError({ code, message: e.message ?? 'team operation failed' })
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const teamRouter = router({
  // -------- Existing presence procedures --------
  members: tenantProcedure
    .input(
      z
        .object({
          tenant_id: z.string().uuid().optional(),
        })
        .optional(),
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
            and(eq(knownInstalls.tenant_id, tenantId), isNull(knownInstalls.revoked_at)),
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
        return []
      }
    }),

  myInstallId: publicProcedure.query(
    async (): Promise<{ install_id: string; display_name: string | null }> => {
      const install = await loadOrCreateInstall()
      let displayName: string | null = null
      try {
        const rows = await db
          .select({ display_name: knownInstalls.display_name })
          .from(knownInstalls)
          .where(eq(knownInstalls.install_id, install.install_id))
          .limit(1)
        displayName = rows[0]?.display_name ?? null
      } catch {
        /* table may not exist in local-only mode */
      }
      return { install_id: install.install_id, display_name: displayName }
    },
  ),

  // -------- Per-project team management --------
  list: tenantProcedure
    .input(z.object({ projectId: z.string().uuid() }))
    .query(async ({ ctx, input }) => {
      try {
        const [members, invites] = await Promise.all([
          listMembers(input.projectId, ctx.tenantId),
          listInvites(input.projectId, ctx.tenantId),
        ])
        const env = readCognitoEnv()
        return {
          members,
          invites,
          cognito: {
            enabled: env.enabled,
            user_pool_id: env.userPoolId,
          },
        }
      } catch (err) {
        logger.error({ err, projectId: input.projectId }, 'team.list failed')
        return {
          members: [],
          invites: [],
          cognito: { enabled: false, user_pool_id: null },
        }
      }
    }),

  invite: tenantProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        email: z.string().email(),
        role: RoleEnum,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await inviteMember({
          projectId: input.projectId,
          tenantId: ctx.tenantId,
          email: input.email,
          role: input.role,
          invitedBy: null,
        })
      } catch (err) {
        trpcError(err)
      }
    }),

  changeRole: tenantProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        userId: z.string().uuid(),
        role: RoleEnum,
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await changeRole({
          projectId: input.projectId,
          tenantId: ctx.tenantId,
          userId: input.userId,
          newRole: input.role,
          actorUserId: null,
        })
      } catch (err) {
        trpcError(err)
      }
    }),

  remove: tenantProcedure
    .input(z.object({ projectId: z.string().uuid(), userId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await removeMember({
          projectId: input.projectId,
          tenantId: ctx.tenantId,
          userId: input.userId,
          actorUserId: null,
        })
      } catch (err) {
        trpcError(err)
      }
    }),

  resendInvite: tenantProcedure
    .input(z.object({ inviteId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await resendInvite({
          inviteId: input.inviteId,
          tenantId: ctx.tenantId,
          actorUserId: null,
        })
      } catch (err) {
        trpcError(err)
      }
    }),

  revokeInvite: tenantProcedure
    .input(z.object({ inviteId: z.string().uuid() }))
    .mutation(async ({ ctx, input }) => {
      try {
        return await revokeInvite({
          inviteId: input.inviteId,
          tenantId: ctx.tenantId,
          actorUserId: null,
        })
      } catch (err) {
        trpcError(err)
      }
    }),

  audit: tenantProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        eventType: EventTypeEnum.optional(),
        limit: z.number().int().min(1).max(200).optional(),
      }),
    )
    .query(async ({ ctx, input }) => {
      try {
        return await listAudit(input.projectId, ctx.tenantId, {
          limit: input.limit,
          eventType: input.eventType,
        })
      } catch (err) {
        logger.error({ err, projectId: input.projectId }, 'team.audit failed')
        return []
      }
    }),

  addExisting: tenantProcedure
    .input(
      z.object({
        projectId: z.string().uuid(),
        email: z.string().email(),
        role: RoleEnum,
        cognitoSub: z.string().optional(),
      }),
    )
    .mutation(async ({ ctx, input }) => {
      try {
        return await addExistingMember({
          projectId: input.projectId,
          tenantId: ctx.tenantId,
          email: input.email,
          role: input.role,
          cognitoSub: input.cognitoSub ?? null,
          actorUserId: null,
        })
      } catch (err) {
        trpcError(err)
      }
    }),
})

export type TeamRouter = typeof teamRouter
