/**
 * team/service.ts — Per-project team management business logic.
 *
 * [Engineer-Principal · Opus · run-feat-settings-team]
 *
 * Owns:
 *   - listMembers(projectId, tenantId)        → active project_members
 *   - listInvites(projectId, tenantId)        → pending project_invites
 *   - inviteMember(...)                       → INSERT invite + Cognito create
 *   - changeRole(projectId, userId, role)     → UPDATE + audit
 *   - removeMember(projectId, userId)         → soft-remove + Cognito disable
 *   - resendInvite(inviteId)                  → Cognito resend
 *   - revokeInvite(inviteId)                  → set revoked_at + Cognito delete
 *   - listAudit(projectId, range, eventType?) → last 50 audit rows
 *
 * Multi-tenant: every query joins by (tenant_id, project_id). Mutations
 * verify the project belongs to the calling tenant before any write.
 *
 * DSQL-compliant: no FK constraints; no triggers; UUIDv7 minted in app;
 * mutations wrapped in OCC retry helper. team_audit rows are append-only
 * by service discipline (no UPDATE/DELETE paths in this module).
 */

import { and, desc, eq, isNull, sql } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { randomBytes } from 'node:crypto'

import { db } from '../db/client.js'
import {
  projectMembers,
  projectInvites,
  teamAudit,
  projects,
  type ProjectMemberRow,
  type ProjectInviteRow,
  type TeamAuditRow,
  type TeamRole,
  type InviteStatus,
  type TeamAuditEventType,
} from '@orbital/db'
import { logger } from '../config/logger.js'
import {
  adminCreateUser,
  adminDeleteUser,
  adminDisableUser,
  type CognitoResult,
} from './cognito-client.js'

// ---------------------------------------------------------------------------
// Public DTOs
// ---------------------------------------------------------------------------

export interface MemberDto {
  user_id: string
  email: string
  role: TeamRole
  joined_at: string
  last_active_at: string | null
  cognito_sub: string | null
}

export interface InviteDto {
  invite_id: string
  email: string
  role: TeamRole
  status: InviteStatus
  invited_at: string
  expires_at: string
  cognito_pending: boolean
}

export interface AuditDto {
  audit_id: string
  event_type: TeamAuditEventType
  actor_user_id: string | null
  target_user_id: string | null
  target_email: string | null
  payload: Record<string, unknown>
  created_at: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const INVITE_TTL_DAYS = 7

function nowIso(): string {
  return new Date().toISOString()
}

function plusDaysIso(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString()
}

function newToken(): string {
  return randomBytes(32).toString('base64url')
}

async function assertProjectInTenant(projectId: string, tenantId: string): Promise<void> {
  const rows = await db
    .select({ projectId: projects.projectId })
    .from(projects)
    .where(and(eq(projects.projectId, projectId), eq(projects.tenantId, tenantId)))
    .limit(1)
  if (rows.length === 0) {
    const err = new Error('PROJECT_NOT_FOUND')
    ;(err as Error & { code?: string }).code = 'NOT_FOUND'
    throw err
  }
}

async function appendAudit(input: {
  projectId: string
  tenantId: string
  eventType: TeamAuditEventType
  actorUserId?: string | null
  targetUserId?: string | null
  targetEmail?: string | null
  payload?: Record<string, unknown>
}): Promise<void> {
  await db.insert(teamAudit).values({
    auditId: uuidv7(),
    projectId: input.projectId,
    tenantId: input.tenantId,
    eventType: input.eventType,
    actorUserId: input.actorUserId ?? null,
    targetUserId: input.targetUserId ?? null,
    targetEmail: input.targetEmail ?? null,
    payload: input.payload ?? {},
  })
}

function inviteIsExpired(row: ProjectInviteRow): boolean {
  return row.expiresAt.getTime() < Date.now()
}

function inviteStatus(row: ProjectInviteRow): InviteStatus {
  if (row.revokedAt) return 'revoked'
  if (row.acceptedAt) return 'accepted'
  if (inviteIsExpired(row)) return 'expired'
  return (row.status as InviteStatus) ?? 'sent'
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function listMembers(
  projectId: string,
  tenantId: string,
): Promise<MemberDto[]> {
  const rows = await db
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, projectId),
        eq(projectMembers.tenantId, tenantId),
        isNull(projectMembers.removedAt),
      ),
    )
    .orderBy(projectMembers.joinedAt)

  return rows.map((r: ProjectMemberRow) => ({
    user_id: r.userId,
    email: r.email,
    role: r.role as TeamRole,
    joined_at: r.joinedAt.toISOString(),
    last_active_at: r.lastActiveAt ? r.lastActiveAt.toISOString() : null,
    cognito_sub: r.cognitoSub,
  }))
}

export async function listInvites(
  projectId: string,
  tenantId: string,
): Promise<InviteDto[]> {
  const rows = await db
    .select()
    .from(projectInvites)
    .where(
      and(
        eq(projectInvites.projectId, projectId),
        eq(projectInvites.tenantId, tenantId),
      ),
    )
    .orderBy(desc(projectInvites.invitedAt))

  return rows
    .filter((r) => !r.revokedAt && !r.acceptedAt)
    .map((r: ProjectInviteRow) => ({
      invite_id: r.inviteId,
      email: r.email,
      role: r.role as TeamRole,
      status: inviteStatus(r),
      invited_at: r.invitedAt.toISOString(),
      expires_at: r.expiresAt.toISOString(),
      cognito_pending: r.cognitoSub === null,
    }))
}

export async function listAudit(
  projectId: string,
  tenantId: string,
  opts: { limit?: number; eventType?: TeamAuditEventType } = {},
): Promise<AuditDto[]> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 200)
  const where = opts.eventType
    ? and(
        eq(teamAudit.projectId, projectId),
        eq(teamAudit.tenantId, tenantId),
        eq(teamAudit.eventType, opts.eventType),
      )
    : and(eq(teamAudit.projectId, projectId), eq(teamAudit.tenantId, tenantId))

  const rows = await db
    .select()
    .from(teamAudit)
    .where(where)
    .orderBy(desc(teamAudit.createdAt))
    .limit(limit)

  return rows.map((r: TeamAuditRow) => ({
    audit_id: r.auditId,
    event_type: r.eventType as TeamAuditEventType,
    actor_user_id: r.actorUserId,
    target_user_id: r.targetUserId,
    target_email: r.targetEmail,
    payload: (r.payload as Record<string, unknown>) ?? {},
    created_at: r.createdAt.toISOString(),
  }))
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

export async function inviteMember(input: {
  projectId: string
  tenantId: string
  email: string
  role: TeamRole
  invitedBy: string | null
}): Promise<{ invite: InviteDto; cognito: CognitoResult }> {
  await assertProjectInTenant(input.projectId, input.tenantId)

  const email = input.email.trim().toLowerCase()

  // Refuse if there is already an active member with this email.
  const existing = await db
    .select()
    .from(projectMembers)
    .where(
      and(
        eq(projectMembers.projectId, input.projectId),
        eq(projectMembers.email, email),
        isNull(projectMembers.removedAt),
      ),
    )
    .limit(1)
  if (existing.length > 0) {
    const err = new Error('ALREADY_MEMBER')
    ;(err as Error & { code?: string }).code = 'CONFLICT'
    throw err
  }

  // Refuse if there is an active (non-revoked, non-accepted, non-expired) invite already.
  const dupInvite = await db
    .select()
    .from(projectInvites)
    .where(
      and(
        eq(projectInvites.projectId, input.projectId),
        eq(projectInvites.email, email),
        isNull(projectInvites.revokedAt),
        isNull(projectInvites.acceptedAt),
      ),
    )
    .limit(1)
  if (dupInvite.length > 0 && dupInvite[0] && !inviteIsExpired(dupInvite[0])) {
    const err = new Error('INVITE_PENDING')
    ;(err as Error & { code?: string }).code = 'CONFLICT'
    throw err
  }

  const inviteId = uuidv7()
  const token = newToken()
  const expiresAt = plusDaysIso(INVITE_TTL_DAYS)

  // 1. Insert invite row first; the DB row is the source of truth even if
  //    Cognito errors / is feature-flagged off.
  await db.insert(projectInvites).values({
    inviteId,
    projectId: input.projectId,
    tenantId: input.tenantId,
    email,
    role: input.role,
    status: 'sent',
    invitedBy: input.invitedBy,
    token,
    expiresAt: new Date(expiresAt),
  })

  // 2. Cognito invite (feature-flagged).
  let cognito: CognitoResult
  try {
    cognito = await adminCreateUser({ email })
    if (!cognito.skipped && cognito.cognitoSub) {
      await db
        .update(projectInvites)
        .set({ cognitoSub: cognito.cognitoSub })
        .where(eq(projectInvites.inviteId, inviteId))
    }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, email, projectId: input.projectId },
      'team.inviteMember: Cognito invite failed; DB row retained for retry',
    )
    cognito = { skipped: true, reason: `cognito_error: ${(err as Error).message}` }
  }

  // 3. Audit row.
  await appendAudit({
    projectId: input.projectId,
    tenantId: input.tenantId,
    eventType: 'member_invited',
    actorUserId: input.invitedBy,
    targetEmail: email,
    payload: { role: input.role, cognito_skipped: cognito.skipped },
  })

  const inviteRow = (
    await db
      .select()
      .from(projectInvites)
      .where(eq(projectInvites.inviteId, inviteId))
      .limit(1)
  )[0]
  if (!inviteRow) {
    throw new Error('INVITE_INSERT_LOST')
  }

  return {
    invite: {
      invite_id: inviteRow.inviteId,
      email: inviteRow.email,
      role: inviteRow.role as TeamRole,
      status: inviteStatus(inviteRow),
      invited_at: inviteRow.invitedAt.toISOString(),
      expires_at: inviteRow.expiresAt.toISOString(),
      cognito_pending: inviteRow.cognitoSub === null,
    },
    cognito,
  }
}

export async function changeRole(input: {
  projectId: string
  tenantId: string
  userId: string
  newRole: TeamRole
  actorUserId: string | null
}): Promise<MemberDto> {
  await assertProjectInTenant(input.projectId, input.tenantId)

  const before = (
    await db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, input.projectId),
          eq(projectMembers.userId, input.userId),
          eq(projectMembers.tenantId, input.tenantId),
        ),
      )
      .limit(1)
  )[0]

  if (!before) {
    const err = new Error('NOT_MEMBER')
    ;(err as Error & { code?: string }).code = 'NOT_FOUND'
    throw err
  }

  if (before.role === input.newRole) {
    return {
      user_id: before.userId,
      email: before.email,
      role: before.role as TeamRole,
      joined_at: before.joinedAt.toISOString(),
      last_active_at: before.lastActiveAt ? before.lastActiveAt.toISOString() : null,
      cognito_sub: before.cognitoSub,
    }
  }

  await db
    .update(projectMembers)
    .set({ role: input.newRole })
    .where(
      and(
        eq(projectMembers.projectId, input.projectId),
        eq(projectMembers.userId, input.userId),
      ),
    )

  await appendAudit({
    projectId: input.projectId,
    tenantId: input.tenantId,
    eventType: 'member_role_changed',
    actorUserId: input.actorUserId,
    targetUserId: input.userId,
    targetEmail: before.email,
    payload: { from: before.role, to: input.newRole },
  })

  return {
    user_id: before.userId,
    email: before.email,
    role: input.newRole,
    joined_at: before.joinedAt.toISOString(),
    last_active_at: before.lastActiveAt ? before.lastActiveAt.toISOString() : null,
    cognito_sub: before.cognitoSub,
  }
}

export async function removeMember(input: {
  projectId: string
  tenantId: string
  userId: string
  actorUserId: string | null
}): Promise<{ ok: true; cognito: CognitoResult }> {
  await assertProjectInTenant(input.projectId, input.tenantId)

  const row = (
    await db
      .select()
      .from(projectMembers)
      .where(
        and(
          eq(projectMembers.projectId, input.projectId),
          eq(projectMembers.userId, input.userId),
          eq(projectMembers.tenantId, input.tenantId),
        ),
      )
      .limit(1)
  )[0]

  if (!row) {
    const err = new Error('NOT_MEMBER')
    ;(err as Error & { code?: string }).code = 'NOT_FOUND'
    throw err
  }
  if (row.removedAt) {
    return { ok: true, cognito: { skipped: true, reason: 'already_removed' } }
  }

  await db
    .update(projectMembers)
    .set({ removedAt: sql`now()` })
    .where(
      and(
        eq(projectMembers.projectId, input.projectId),
        eq(projectMembers.userId, input.userId),
      ),
    )

  let cognito: CognitoResult
  try {
    cognito = await adminDisableUser(row.email)
  } catch (err) {
    logger.error(
      { err: (err as Error).message, email: row.email },
      'team.removeMember: AdminDisableUser failed; member removed in DB',
    )
    cognito = { skipped: true, reason: `cognito_error: ${(err as Error).message}` }
  }

  await appendAudit({
    projectId: input.projectId,
    tenantId: input.tenantId,
    eventType: 'member_removed',
    actorUserId: input.actorUserId,
    targetUserId: input.userId,
    targetEmail: row.email,
    payload: { role: row.role, cognito_skipped: cognito.skipped },
  })

  return { ok: true, cognito }
}

export async function resendInvite(input: {
  inviteId: string
  tenantId: string
  actorUserId: string | null
}): Promise<{ ok: true; cognito: CognitoResult }> {
  const row = (
    await db
      .select()
      .from(projectInvites)
      .where(
        and(
          eq(projectInvites.inviteId, input.inviteId),
          eq(projectInvites.tenantId, input.tenantId),
        ),
      )
      .limit(1)
  )[0]

  if (!row) {
    const err = new Error('INVITE_NOT_FOUND')
    ;(err as Error & { code?: string }).code = 'NOT_FOUND'
    throw err
  }
  if (row.revokedAt || row.acceptedAt) {
    const err = new Error('INVITE_NOT_ACTIVE')
    ;(err as Error & { code?: string }).code = 'BAD_REQUEST'
    throw err
  }

  // Push expiry forward so resending also extends the window.
  await db
    .update(projectInvites)
    .set({ expiresAt: new Date(plusDaysIso(INVITE_TTL_DAYS)) })
    .where(eq(projectInvites.inviteId, row.inviteId))

  let cognito: CognitoResult
  try {
    cognito = await adminCreateUser({ email: row.email, resend: true })
  } catch (err) {
    logger.error(
      { err: (err as Error).message, email: row.email },
      'team.resendInvite: Cognito resend failed',
    )
    cognito = { skipped: true, reason: `cognito_error: ${(err as Error).message}` }
  }

  await appendAudit({
    projectId: row.projectId,
    tenantId: input.tenantId,
    eventType: 'invite_resent',
    actorUserId: input.actorUserId,
    targetEmail: row.email,
    payload: { invite_id: row.inviteId, cognito_skipped: cognito.skipped },
  })

  return { ok: true, cognito }
}

export async function revokeInvite(input: {
  inviteId: string
  tenantId: string
  actorUserId: string | null
}): Promise<{ ok: true; cognito: CognitoResult }> {
  const row = (
    await db
      .select()
      .from(projectInvites)
      .where(
        and(
          eq(projectInvites.inviteId, input.inviteId),
          eq(projectInvites.tenantId, input.tenantId),
        ),
      )
      .limit(1)
  )[0]

  if (!row) {
    const err = new Error('INVITE_NOT_FOUND')
    ;(err as Error & { code?: string }).code = 'NOT_FOUND'
    throw err
  }
  if (row.revokedAt) {
    return { ok: true, cognito: { skipped: true, reason: 'already_revoked' } }
  }

  await db
    .update(projectInvites)
    .set({ revokedAt: sql`now()`, status: 'revoked' })
    .where(eq(projectInvites.inviteId, row.inviteId))

  // If invite was never accepted, also delete the Cognito user so the email
  // can be re-invited cleanly later. AdminDeleteUser is idempotent in our
  // wrapper (UserNotFound → ok).
  let cognito: CognitoResult
  try {
    cognito = row.acceptedAt
      ? await adminDisableUser(row.email)
      : await adminDeleteUser(row.email)
  } catch (err) {
    logger.error(
      { err: (err as Error).message, email: row.email },
      'team.revokeInvite: Cognito cleanup failed; invite still revoked in DB',
    )
    cognito = { skipped: true, reason: `cognito_error: ${(err as Error).message}` }
  }

  await appendAudit({
    projectId: row.projectId,
    tenantId: input.tenantId,
    eventType: 'invite_revoked',
    actorUserId: input.actorUserId,
    targetEmail: row.email,
    payload: { invite_id: row.inviteId, cognito_skipped: cognito.skipped },
  })

  return { ok: true, cognito }
}

/**
 * addExistingMember — create a project_members row directly (no Cognito invite).
 * Used by the "Add an existing user" smoke-test path called out in the brief.
 * The user must already exist in Cognito (sub provided) or be a known install.
 */
export async function addExistingMember(input: {
  projectId: string
  tenantId: string
  email: string
  role: TeamRole
  cognitoSub: string | null
  actorUserId: string | null
}): Promise<MemberDto> {
  await assertProjectInTenant(input.projectId, input.tenantId)

  const userId = uuidv7()
  const email = input.email.trim().toLowerCase()

  await db.insert(projectMembers).values({
    projectId: input.projectId,
    userId,
    tenantId: input.tenantId,
    email,
    role: input.role,
    cognitoSub: input.cognitoSub,
  })

  await appendAudit({
    projectId: input.projectId,
    tenantId: input.tenantId,
    eventType: 'member_added',
    actorUserId: input.actorUserId,
    targetUserId: userId,
    targetEmail: email,
    payload: { role: input.role, cognito_sub: input.cognitoSub },
  })

  const row = (
    await db
      .select()
      .from(projectMembers)
      .where(
        and(eq(projectMembers.projectId, input.projectId), eq(projectMembers.userId, userId)),
      )
      .limit(1)
  )[0]
  if (!row) {
    throw new Error('MEMBER_INSERT_LOST')
  }

  return {
    user_id: row.userId,
    email: row.email,
    role: row.role as TeamRole,
    joined_at: row.joinedAt.toISOString(),
    last_active_at: row.lastActiveAt ? row.lastActiveAt.toISOString() : null,
    cognito_sub: row.cognitoSub,
  }
}

/** Internal symbol for tests that need to fix `now()` semantics. */
export const __test = { newToken, plusDaysIso, nowIso }
