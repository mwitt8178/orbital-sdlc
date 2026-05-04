/**
 * TeamTab — per-project team management.
 *
 * [Engineer-Principal · Opus · run-feat-settings-team]
 *
 * Sections:
 *   1. Members — table + change-role dropdown + remove (typed-confirm)
 *   2. Invitations — pending invites + resend / revoke
 *   3. Invite member — email + role form (real Cognito invite)
 *   4. Audit log — last 50 events, filterable by event type
 *
 * Real wiring:
 *   - trpc.team.list / invite / changeRole / remove / resendInvite /
 *     revokeInvite / audit / addExisting
 *   - Optimistic updates on invite are server-confirmed via list refetch.
 *
 * Cognito IAM is feature-flagged on the server. When disabled the UI shows
 * a yellow banner and invites carry `cognito_pending: true`.
 */

import { type FormEvent, useMemo, useState } from 'react'
import { useActiveProject } from '../../../services/use-active-project.js'
import { trpc } from '../../../services/trpc.js'
import { useToast } from '../../../services/use-toast.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Badge } from '../../ui/Badge.js'
import { Button } from '../../ui/Button.js'
import { Input } from '../../ui/Input.js'
import { FormField } from '../../ui/FormField.js'
import { ConfirmDialog } from '../../ui/ConfirmDialog.js'

const ROLE_OPTIONS = [
  { value: 'admin', label: 'Admin' },
  { value: 'member', label: 'Member' },
  { value: 'viewer', label: 'Viewer' },
] as const

type Role = (typeof ROLE_OPTIONS)[number]['value']

const EVENT_FILTERS = [
  { value: '', label: 'All events' },
  { value: 'member_invited', label: 'Invited' },
  { value: 'member_added', label: 'Added' },
  { value: 'member_role_changed', label: 'Role changed' },
  { value: 'member_removed', label: 'Removed' },
  { value: 'invite_resent', label: 'Resent' },
  { value: 'invite_revoked', label: 'Revoked' },
] as const

function isDowngrade(from: Role, to: Role): boolean {
  const order: Record<Role, number> = { admin: 3, member: 2, viewer: 1 }
  return order[to] < order[from]
}

function relative(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const min = Math.floor(diff / 60_000)
  if (min < 1) return 'just now'
  if (min < 60) return `${min}m ago`
  const hr = Math.floor(min / 60)
  if (hr < 24) return `${hr}h ago`
  const d = Math.floor(hr / 24)
  if (d < 30) return `${d}d ago`
  return new Date(iso).toLocaleDateString()
}

export function TeamTab() {
  const { activeProjectId, isLoading: projectLoading } = useActiveProject()

  if (projectLoading) {
    return <Skeleton rows={6} />
  }
  if (!activeProjectId) {
    return (
      <ErrorMessage
        title="No active project"
        message="Pick a project from the breadcrumb to manage its team."
      />
    )
  }

  return <TeamTabInner projectId={activeProjectId} />
}

function TeamTabInner({ projectId }: { projectId: string }) {
  const toast = useToast()
  const utils = trpc.useUtils()

  const list = trpc.team.list.useQuery({ projectId })
  const audit = trpc.team.audit.useQuery({ projectId, limit: 50 })

  const invalidateAll = async () => {
    await Promise.all([
      utils.team.list.invalidate({ projectId }),
      utils.team.audit.invalidate({ projectId }),
    ])
  }

  const inviteMut = trpc.team.invite.useMutation({
    onSuccess: async (_data) => {
      toast.success('Invite sent')
      await invalidateAll()
    },
    onError: (err) => toast.error('Could not send invite', { description: err.message }),
  })
  const changeRoleMut = trpc.team.changeRole.useMutation({
    onSuccess: async () => {
      toast.success('Role updated')
      await invalidateAll()
    },
    onError: (err) => toast.error('Could not change role', { description: err.message }),
  })
  const removeMut = trpc.team.remove.useMutation({
    onSuccess: async () => {
      toast.success('Member removed')
      await invalidateAll()
    },
    onError: (err) => toast.error('Could not remove member', { description: err.message }),
  })
  const resendMut = trpc.team.resendInvite.useMutation({
    onSuccess: async () => {
      toast.success('Invite resent')
      await invalidateAll()
    },
    onError: (err) => toast.error('Could not resend invite', { description: err.message }),
  })
  const revokeMut = trpc.team.revokeInvite.useMutation({
    onSuccess: async () => {
      toast.success('Invite revoked')
      await invalidateAll()
    },
    onError: (err) => toast.error('Could not revoke invite', { description: err.message }),
  })

  if (list.isLoading) return <Skeleton rows={8} />
  if (list.error) {
    return <ErrorMessage title="Could not load team" message={list.error.message} />
  }

  const data = list.data
  const cognitoEnabled = data?.cognito.enabled ?? false

  return (
    <div className="space-y-6">
      {!cognitoEnabled && (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
          <strong className="font-semibold">Cognito invites are pending IAM approval.</strong>{' '}
          Invites are recorded in the database and shown below as “pending” — they will not send
          email until <code className="font-mono">ORBITAL_TEAM_COGNITO_ENABLED=true</code> is set
          on the api-lambda role and the role is granted{' '}
          <code className="font-mono">cognito-idp:AdminCreateUser</code> on user pool{' '}
          <code className="font-mono">us-east-1_R89dMIxXb</code>.
        </div>
      )}

      <MembersSection
        members={data?.members ?? []}
        onChangeRole={(userId, currentRole, newRole) =>
          changeRoleMut.mutate({ projectId, userId, role: newRole })
        }
        onRemove={(userId) => removeMut.mutate({ projectId, userId })}
        changeRolePending={changeRoleMut.isPending}
        removePending={removeMut.isPending}
      />

      <InvitesSection
        invites={data?.invites ?? []}
        onResend={(inviteId) => resendMut.mutate({ inviteId })}
        onRevoke={(inviteId) => revokeMut.mutate({ inviteId })}
        resendPending={resendMut.isPending}
        revokePending={revokeMut.isPending}
      />

      <InviteForm
        onSubmit={(email, role) => inviteMut.mutate({ projectId, email, role })}
        pending={inviteMut.isPending}
        error={inviteMut.error?.message ?? null}
      />

      <AuditSection rows={audit.data ?? []} loading={audit.isLoading} />
    </div>
  )
}

// ---------------------------------------------------------------------------
// Members table
// ---------------------------------------------------------------------------

interface MemberDto {
  user_id: string
  email: string
  role: Role
  joined_at: string
  last_active_at: string | null
}

function MembersSection(props: {
  members: MemberDto[]
  onChangeRole: (userId: string, currentRole: Role, newRole: Role) => void
  onRemove: (userId: string) => void
  changeRolePending: boolean
  removePending: boolean
}) {
  const [pendingRoleChange, setPendingRoleChange] = useState<{
    userId: string
    email: string
    from: Role
    to: Role
  } | null>(null)
  const [pendingRemove, setPendingRemove] = useState<{ userId: string; email: string } | null>(null)

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-900">Members</h3>
        <span className="text-xs text-slate-500">{props.members.length} active</span>
      </header>
      {props.members.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">
          No members yet. Use the invite form below to add the first one.
        </p>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Email</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">Joined</th>
              <th className="px-4 py-2 font-medium">Last active</th>
              <th className="px-4 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {props.members.map((m) => (
              <tr key={m.user_id}>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-800">{m.email}</td>
                <td className="px-4 py-2.5">
                  <select
                    aria-label={`Role for ${m.email}`}
                    value={m.role}
                    disabled={props.changeRolePending}
                    onChange={(e) => {
                      const next = e.target.value as Role
                      if (next === m.role) return
                      if (isDowngrade(m.role, next)) {
                        setPendingRoleChange({
                          userId: m.user_id,
                          email: m.email,
                          from: m.role,
                          to: next,
                        })
                      } else {
                        props.onChangeRole(m.user_id, m.role, next)
                      }
                    }}
                    className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs"
                  >
                    {ROLE_OPTIONS.map((r) => (
                      <option key={r.value} value={r.value}>
                        {r.label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="px-4 py-2.5 text-xs text-slate-600">{relative(m.joined_at)}</td>
                <td className="px-4 py-2.5 text-xs text-slate-600">
                  {m.last_active_at ? relative(m.last_active_at) : '—'}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setPendingRemove({ userId: m.user_id, email: m.email })}
                    disabled={props.removePending}
                  >
                    Remove
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <ConfirmDialog
        open={pendingRoleChange !== null}
        title="Downgrade member?"
        body={
          pendingRoleChange ? (
            <p className="text-sm text-slate-600">
              You’re changing <strong>{pendingRoleChange.email}</strong> from{' '}
              <strong>{pendingRoleChange.from}</strong> to{' '}
              <strong>{pendingRoleChange.to}</strong>. They’ll lose access to actions reserved for
              the higher role.
            </p>
          ) : null
        }
        confirmLabel="Change role"
        variant="danger"
        pending={props.changeRolePending}
        onCancel={() => setPendingRoleChange(null)}
        onConfirm={() => {
          if (!pendingRoleChange) return
          props.onChangeRole(
            pendingRoleChange.userId,
            pendingRoleChange.from,
            pendingRoleChange.to,
          )
          setPendingRoleChange(null)
        }}
      />

      <ConfirmDialog
        open={pendingRemove !== null}
        title="Remove member?"
        body={
          pendingRemove ? (
            <p className="text-sm text-slate-600">
              This removes <strong>{pendingRemove.email}</strong> from the project and disables
              their Cognito sign-in. Type the email to confirm.
            </p>
          ) : null
        }
        confirmLabel="Remove member"
        variant="danger"
        confirmText={pendingRemove?.email}
        pending={props.removePending}
        onCancel={() => setPendingRemove(null)}
        onConfirm={() => {
          if (!pendingRemove) return
          props.onRemove(pendingRemove.userId)
          setPendingRemove(null)
        }}
      />
    </section>
  )
}

// ---------------------------------------------------------------------------
// Pending invitations
// ---------------------------------------------------------------------------

interface InviteDto {
  invite_id: string
  email: string
  role: Role
  status: 'sent' | 'accepted' | 'expired' | 'revoked'
  invited_at: string
  expires_at: string
  cognito_pending: boolean
}

function InvitesSection(props: {
  invites: InviteDto[]
  onResend: (inviteId: string) => void
  onRevoke: (inviteId: string) => void
  resendPending: boolean
  revokePending: boolean
}) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-900">Pending invitations</h3>
        <span className="text-xs text-slate-500">{props.invites.length}</span>
      </header>
      {props.invites.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">No pending invites.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-2 font-medium">Email</th>
              <th className="px-4 py-2 font-medium">Role</th>
              <th className="px-4 py-2 font-medium">Invited</th>
              <th className="px-4 py-2 font-medium">Status</th>
              <th className="px-4 py-2 text-right font-medium">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {props.invites.map((inv) => (
              <tr key={inv.invite_id}>
                <td className="px-4 py-2.5 font-mono text-xs text-slate-800">{inv.email}</td>
                <td className="px-4 py-2.5 text-xs capitalize text-slate-700">{inv.role}</td>
                <td className="px-4 py-2.5 text-xs text-slate-600">{relative(inv.invited_at)}</td>
                <td className="px-4 py-2.5">
                  <Badge
                    color={
                      inv.status === 'sent'
                        ? inv.cognito_pending
                          ? 'amber'
                          : 'sky'
                        : inv.status === 'expired'
                          ? 'slate'
                          : 'rose'
                    }
                  >
                    {inv.cognito_pending && inv.status === 'sent' ? 'pending IAM' : inv.status}
                  </Badge>
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex justify-end gap-1.5">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={props.resendPending}
                      onClick={() => props.onResend(inv.invite_id)}
                    >
                      Resend
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={props.revokePending}
                      onClick={() => props.onRevoke(inv.invite_id)}
                    >
                      Revoke
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Invite form
// ---------------------------------------------------------------------------

function InviteForm(props: {
  onSubmit: (email: string, role: Role) => void
  pending: boolean
  error: string | null
}) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('member')
  const [emailError, setEmailError] = useState<string | null>(null)

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault()
    const trimmed = email.trim()
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setEmailError('Enter a valid email address')
      return
    }
    setEmailError(null)
    props.onSubmit(trimmed, role)
    setEmail('')
  }

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <header className="border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-900">Invite member</h3>
      </header>
      <form onSubmit={handleSubmit} className="grid gap-3 px-4 py-4 md:grid-cols-[2fr_1fr_auto]">
        <FormField label="Email" error={emailError ?? undefined}>
          <Input
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="teammate@company.com"
            autoComplete="email"
            disabled={props.pending}
          />
        </FormField>
        <FormField label="Role">
          <select
            value={role}
            onChange={(e) => setRole(e.target.value as Role)}
            disabled={props.pending}
            className="w-full rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-sm"
          >
            {ROLE_OPTIONS.map((r) => (
              <option key={r.value} value={r.value}>
                {r.label}
              </option>
            ))}
          </select>
        </FormField>
        <div className="flex items-end">
          <Button type="submit" disabled={props.pending}>
            {props.pending ? 'Sending…' : 'Send invite'}
          </Button>
        </div>
        {props.error && (
          <p className="md:col-span-3 text-xs text-rose-600" role="alert">
            {props.error}
          </p>
        )}
      </form>
    </section>
  )
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

interface AuditDto {
  audit_id: string
  event_type: string
  actor_user_id: string | null
  target_user_id: string | null
  target_email: string | null
  payload: Record<string, unknown>
  created_at: string
}

function AuditSection(props: { rows: AuditDto[]; loading: boolean }) {
  const [filter, setFilter] = useState<string>('')
  const filtered = useMemo(
    () => (filter ? props.rows.filter((r) => r.event_type === filter) : props.rows),
    [props.rows, filter],
  )

  return (
    <section className="rounded-lg border border-slate-200 bg-white">
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-900">Audit log</h3>
        <select
          aria-label="Filter audit events"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs"
        >
          {EVENT_FILTERS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </header>
      {props.loading ? (
        <div className="px-4 py-4">
          <Skeleton rows={4} />
        </div>
      ) : filtered.length === 0 ? (
        <p className="px-4 py-6 text-sm text-slate-500">No events yet.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {filtered.map((row) => (
            <li key={row.audit_id} className="grid gap-1 px-4 py-2.5 text-xs md:grid-cols-[10rem_1fr_8rem]">
              <span className="font-mono text-[11px] uppercase tracking-wide text-slate-500">
                {row.event_type.replace('member_', '').replace('invite_', 'invite ')}
              </span>
              <span className="font-mono text-slate-800">
                {row.target_email ?? row.target_user_id ?? '—'}
              </span>
              <span className="text-right text-slate-500">{relative(row.created_at)}</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
