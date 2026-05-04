/**
 * team.ts — Drizzle schema for per-project team management.
 *
 * [Engineer-Principal · Opus · run-feat-settings-team]
 *
 * Aggregates:
 *   - project_members  (project, user, role, lifecycle)
 *   - project_invites  (pending invitations bound to a Cognito email)
 *   - team_audit       (append-only stream of member/role events)
 *
 * DSQL constraints honoured: no FKs, no triggers, no sequences.
 * Tenant isolation: every row carries tenant_id; service queries always
 * filter by both tenant_id AND project_id.
 */

import {
  pgTable,
  uuid,
  text,
  timestamp,
  jsonb,
  index,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/pg-core'

export const projectMembers = pgTable(
  'project_members',
  {
    projectId: uuid('project_id').notNull(),
    userId: uuid('user_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .default('00000000-0000-0000-0000-000000000000'),
    email: text('email').notNull(),
    cognitoSub: text('cognito_sub'),
    role: text('role').notNull(),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    lastActiveAt: timestamp('last_active_at', { withTimezone: true }),
    removedAt: timestamp('removed_at', { withTimezone: true }),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.projectId, t.userId] }),
    activeIdx: index('project_members_project_active_idx').on(t.projectId, t.removedAt),
    tenantIdx: index('project_members_tenant_idx').on(t.tenantId),
    emailUniq: uniqueIndex('project_members_project_email_uniq').on(t.projectId, t.email),
  }),
)

export const projectInvites = pgTable(
  'project_invites',
  {
    inviteId: uuid('invite_id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .default('00000000-0000-0000-0000-000000000000'),
    email: text('email').notNull(),
    role: text('role').notNull(),
    status: text('status').notNull().default('sent'),
    invitedAt: timestamp('invited_at', { withTimezone: true }).notNull().defaultNow(),
    invitedBy: uuid('invited_by'),
    token: text('token').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    cognitoSub: text('cognito_sub'),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
  },
  (t) => ({
    statusIdx: index('project_invites_project_status_idx').on(t.projectId, t.status),
    tenantIdx: index('project_invites_tenant_idx').on(t.tenantId),
    tokenUniq: uniqueIndex('project_invites_token_uniq').on(t.token),
  }),
)

export const teamAudit = pgTable(
  'team_audit',
  {
    auditId: uuid('audit_id').primaryKey(),
    projectId: uuid('project_id').notNull(),
    tenantId: uuid('tenant_id')
      .notNull()
      .default('00000000-0000-0000-0000-000000000000'),
    eventType: text('event_type').notNull(),
    actorUserId: uuid('actor_user_id'),
    targetUserId: uuid('target_user_id'),
    targetEmail: text('target_email'),
    payload: jsonb('payload').notNull().default({}),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    projectCreatedIdx: index('team_audit_project_created_idx').on(t.projectId, t.createdAt),
    projectEventIdx: index('team_audit_project_event_idx').on(t.projectId, t.eventType, t.createdAt),
  }),
)

export type ProjectMemberRow = typeof projectMembers.$inferSelect
export type ProjectMemberInsert = typeof projectMembers.$inferInsert
export type ProjectInviteRow = typeof projectInvites.$inferSelect
export type ProjectInviteInsert = typeof projectInvites.$inferInsert
export type TeamAuditRow = typeof teamAudit.$inferSelect
export type TeamAuditInsert = typeof teamAudit.$inferInsert

export const TEAM_ROLES = ['admin', 'member', 'viewer'] as const
export type TeamRole = (typeof TEAM_ROLES)[number]

export const INVITE_STATUSES = ['sent', 'accepted', 'expired', 'revoked'] as const
export type InviteStatus = (typeof INVITE_STATUSES)[number]

export const TEAM_AUDIT_EVENTS = [
  'member_invited',
  'member_added',
  'member_role_changed',
  'member_removed',
  'invite_resent',
  'invite_revoked',
] as const
export type TeamAuditEventType = (typeof TEAM_AUDIT_EVENTS)[number]
