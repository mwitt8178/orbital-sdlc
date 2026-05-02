/**
 * CeremonyCard — list-item card for a ceremony in the Ceremonies page.
 *
 * Displays:
 *   - Ceremony kind + title
 *   - Status pill (scheduled / in_progress / closed)
 *   - Participants (avatar initials)
 *   - Trigger source chip:
 *       "🤖 Auto · <rule_id> · <reason>"  when trigger metadata is present
 *       "👤 Override"                      when ceremony was manually created
 *                                          OR trigger info not yet available
 *
 * DEFERRED: clicking the card to open CeremonyView is a future interaction.
 * The card is currently display-only. Navigation will be wired when the
 * Ceremonies page gains routing per-ceremony.
 */

import clsx from 'clsx'
import { type CeremonyView } from '../../../store/ceremonies.js'

// ---------------------------------------------------------------------------
// Status pill
// ---------------------------------------------------------------------------

const STATUS_LABELS: Record<string, string> = {
  scheduled: 'Scheduled',
  in_progress: 'Live',
  closed: 'Closed',
}

const STATUS_COLORS: Record<string, string> = {
  scheduled: 'bg-blue-50 text-blue-700 border-blue-200',
  in_progress: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  closed: 'bg-slate-100 text-slate-500 border-slate-200',
}

function StatusPill({ status }: { status: string }) {
  const label = STATUS_LABELS[status] ?? status
  const color = STATUS_COLORS[status] ?? STATUS_COLORS['closed']
  return (
    <span
      className={clsx(
        'inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide',
        color,
      )}
    >
      {status === 'in_progress' && (
        <span
          aria-hidden="true"
          className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-emerald-500"
        />
      )}
      {label}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Trigger chip
// ---------------------------------------------------------------------------

interface TriggerChipProps {
  trigger?: CeremonyView['trigger']
}

export function TriggerChip({ trigger }: TriggerChipProps) {
  if (trigger) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded bg-indigo-50 px-2 py-0.5 text-[11px] text-indigo-700"
        title={`Trigger event: ${trigger.trigger_event_id}`}
      >
        <span aria-hidden="true">🤖</span>
        <span>
          Auto · <strong>{trigger.rule_id}</strong> · {trigger.reason}
        </span>
      </span>
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500">
      <span aria-hidden="true">👤</span>
      <span>Override</span>
    </span>
  )
}

// ---------------------------------------------------------------------------
// Avatar initials helper
// ---------------------------------------------------------------------------

function avatarInitials(role: string): string {
  return role
    .split(/[-_\s]/)
    .slice(0, 2)
    .map((w) => w[0]?.toUpperCase() ?? '')
    .join('')
}

const AVATAR_COLORS = [
  'bg-indigo-100 text-indigo-700',
  'bg-violet-100 text-violet-700',
  'bg-emerald-100 text-emerald-700',
  'bg-amber-100 text-amber-700',
  'bg-rose-100 text-rose-700',
  'bg-blue-100 text-blue-700',
]

function participantColor(role: string): string {
  let hash = 0
  for (let i = 0; i < role.length; i++) hash = (hash * 31 + role.charCodeAt(i)) >>> 0
  return AVATAR_COLORS[hash % AVATAR_COLORS.length]!
}

// ---------------------------------------------------------------------------
// CeremonyCard
// ---------------------------------------------------------------------------

interface CeremonyCardProps {
  ceremony: CeremonyView
}

export function CeremonyCard({ ceremony }: CeremonyCardProps) {
  const status = ceremony.status ?? (ceremony.closedAt ? 'closed' : 'in_progress')
  const displayParticipants = ceremony.participants.slice(0, 5)
  const overflow = ceremony.participants.length - displayParticipants.length

  return (
    <article
      className="rounded-lg border border-slate-200 bg-white px-4 py-3 shadow-sm transition hover:border-slate-300 hover:shadow-md"
      aria-label={`Ceremony: ${ceremony.title}`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          {/* Title row */}
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-slate-900">{ceremony.title}</span>
            <StatusPill status={status} />
          </div>

          {/* Kind + started */}
          <p className="mt-0.5 text-xs text-slate-500">
            {ceremony.kind} · started{' '}
            {new Date(ceremony.startedAt).toLocaleTimeString(undefined, {
              hour: '2-digit',
              minute: '2-digit',
            })}
            {ceremony.closedAt && (
              <>
                {' '}
                · closed{' '}
                {new Date(ceremony.closedAt).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </>
            )}
          </p>

          {/* Trigger chip */}
          <div className="mt-1.5">
            <TriggerChip trigger={ceremony.trigger} />
          </div>
        </div>

        {/* Participant avatars */}
        {ceremony.participants.length > 0 && (
          <div className="flex flex-shrink-0 -space-x-1.5" aria-label="Participants">
            {displayParticipants.map((p, idx) => (
              <span
                key={`${p.personaRole}-${idx}`}
                className={clsx(
                  'inline-flex h-6 w-6 items-center justify-center rounded-full border-2 border-white text-[8px] font-bold',
                  participantColor(p.personaRole),
                )}
                title={p.personaRole}
                aria-label={p.personaRole}
              >
                {avatarInitials(p.personaRole)}
              </span>
            ))}
            {overflow > 0 && (
              <span
                className="inline-flex h-6 w-6 items-center justify-center rounded-full border-2 border-white bg-slate-100 text-[8px] font-semibold text-slate-500"
                aria-label={`${overflow} more participants`}
              >
                +{overflow}
              </span>
            )}
          </div>
        )}
      </div>
    </article>
  )
}
