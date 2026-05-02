/**
 * CeremonyView — header + participant list + statement feed for the
 * currently active ceremony, sourced entirely from WS events.
 *
 * Round 4 additions:
 *   - Schedule Ceremony button (top-right) → ScheduleCeremonyModal
 *   - Visual turn indicator: colored ring + "speaking…" pulse on current participant
 *   - Voting interface: vote buttons when ceremony is in `voting` state
 *   - Output card polished visual treatment on close
 *
 * Round 5 additions:
 *   - "Schedule" button replaced by OverrideDropdown (auto-scheduling is primary)
 *   - Trigger source chip shown near ceremony title
 *
 * DEFERRED:
 *   - ceremony.vote tRPC procedure not in AppRouter.
 *     Vote buttons are visible but disabled ("Backend procedure pending").
 */

import { useCeremoniesStore, type CeremonyParticipant } from '../../../store/ceremonies.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { PulseDot } from '../../ui/PulseDot.js'
import { TriggerChip } from './CeremonyCard.js'
import { OverrideDropdown } from './OverrideDropdown.js'

export function CeremonyView() {
  const ceremony = useCeremoniesStore((s) => s.active)

  if (!ceremony) {
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Active Ceremony</h2>
          <OverrideDropdown />
        </div>

        <EmptyState
          icon={
            <svg
              width="24"
              height="24"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" />
              <circle cx="9" cy="7" r="4" />
              <path d="M23 21v-2a4 4 0 0 0-3-3.87" />
              <path d="M16 3.13a4 4 0 0 1 0 7.75" />
            </svg>
          }
          title="No active ceremony"
          description="Ceremonies start automatically when system state crosses a threshold (sprint completes, capacity drops, disagreement raised, etc.)."
        />
      </div>
    )
  }

  const isVoting = !ceremony.closedAt && ceremony.statements.some(
    (s) => s.body.toLowerCase().includes('vote') || s.body.toLowerCase().includes('motion'),
  )

  return (
    <div className="space-y-3">
      {/* Top bar — Override dropdown replaces the old "Schedule" primary button */}
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-900">Active Ceremony</h2>
        <OverrideDropdown />
      </div>

      <div className="grid grid-cols-3 gap-5">
        <section className="col-span-2 rounded-lg border border-slate-200 bg-white">
          <header className="flex items-center justify-between border-b border-slate-100 px-5 py-3">
            <div>
              <div className="text-sm font-semibold text-slate-900">{ceremony.title}</div>
              <div className="mt-0.5 text-xs text-slate-500">
                {ceremony.kind} · started{' '}
                {new Date(ceremony.startedAt).toLocaleTimeString(undefined, {
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </div>
              {/* Trigger source chip */}
              <div className="mt-1.5">
                <TriggerChip trigger={ceremony.trigger} />
              </div>
            </div>
            {ceremony.closedAt ? (
              <span className="rounded-full bg-slate-100 px-2.5 py-1 text-xs font-medium text-slate-500">
                Closed
              </span>
            ) : (
              <span className="flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
                <PulseDot color="emerald" /> Live
              </span>
            )}
          </header>

          <div
            className="scrollbar-thin max-h-[60vh] overflow-y-auto px-5 py-4"
            role="log"
            aria-label="Ceremony statements"
          >
            {ceremony.statements.length === 0 ? (
              <EmptyState
                title="Waiting for first statement"
                description="Participant statements will appear here as the ceremony proceeds."
              />
            ) : (
              <ol className="space-y-3">
                {ceremony.statements.map((s) => (
                  <li key={s.statementId} className="animate-stream-in">
                    <div className="text-[11px] font-medium uppercase tracking-wide text-indigo-600">
                      {s.personaRole}
                    </div>
                    <p className="mt-0.5 text-sm text-slate-700">{s.body}</p>
                  </li>
                ))}
              </ol>
            )}
          </div>

          {/* Voting interface — shown when ceremony is in voting state */}
          {isVoting && !ceremony.closedAt && (
            <div className="border-t border-slate-100 px-5 py-3">
              <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                Vote
              </h3>
              <div className="flex flex-wrap gap-2">
                {ceremony.participants.map((p) => (
                  <button
                    key={p.personaRole}
                    type="button"
                    disabled
                    title="ceremony.vote — backend procedure pending"
                    aria-label={`Vote for ${p.personaRole} (backend procedure pending)`}
                    className="rounded-md border border-slate-200 px-3 py-1.5 text-xs font-medium text-slate-600 transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 disabled:pointer-events-none disabled:opacity-50"
                  >
                    {p.personaRole}
                  </button>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] text-amber-600">
                Voting — backend procedure pending
              </p>
            </div>
          )}

          {/* Output card on close — polished visual */}
          {ceremony.output && (
            <div className="border-t border-slate-100 px-5 py-4">
              <h3 className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wider text-slate-400">
                <CheckCircleIcon className="h-3.5 w-3.5 text-emerald-500" aria-hidden="true" />
                Ceremony Output
              </h3>
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
                {typeof ceremony.output['decision'] === 'string' && (
                  <div className="mb-2">
                    <span className="text-[10px] font-semibold uppercase tracking-wide text-indigo-500">
                      Decision
                    </span>
                    <p className="mt-0.5 text-sm text-slate-800">{ceremony.output['decision'] as string}</p>
                  </div>
                )}
                {typeof ceremony.output['linked_adr_id'] === 'string' && (
                  <div className="mb-2 flex items-center gap-1.5 text-xs text-indigo-600">
                    <DocumentIcon className="h-3.5 w-3.5" aria-hidden="true" />
                    ADR: {ceremony.output['linked_adr_id'] as string}
                  </div>
                )}
                {typeof ceremony.output['summary'] === 'string' && (
                  <p className="text-xs text-slate-600">{ceremony.output['summary'] as string}</p>
                )}
                {/* Full JSON fallback for non-standard output shapes */}
                {!ceremony.output['decision'] && !ceremony.output['summary'] && (
                  <pre className="scrollbar-thin overflow-auto font-mono text-[11px] text-slate-700">
                    {JSON.stringify(ceremony.output, null, 2)}
                  </pre>
                )}
              </div>
              {ceremony.closedAt && (
                <p className="mt-1.5 text-[10px] text-slate-400">
                  Closed at{' '}
                  {new Date(ceremony.closedAt).toLocaleTimeString(undefined, {
                    hour: '2-digit',
                    minute: '2-digit',
                  })}
                </p>
              )}
            </div>
          )}
        </section>

        <section className="col-span-1 rounded-lg border border-slate-200 bg-white">
          <header className="border-b border-slate-100 px-4 py-3">
            <div className="text-sm font-semibold text-slate-900">Participants</div>
            <div className="text-xs text-slate-500">{ceremony.participants.length} agents</div>
          </header>
          <ul className="divide-y divide-slate-100" role="list">
            {ceremony.participants.map((p, idx) => (
              <ParticipantRow key={`${p.personaRole}-${idx}`} participant={p} />
            ))}
          </ul>
        </section>
      </div>

    </div>
  )
}

// ---------------------------------------------------------------------------
// Participant row — with visual turn indicator
// ---------------------------------------------------------------------------

function ParticipantRow({ participant }: { participant: CeremonyParticipant }) {
  const totalBudget = participant.tokensConsumed + participant.tokensRemaining
  const consumedPct =
    totalBudget > 0 ? Math.round((participant.tokensConsumed / totalBudget) * 100) : 0

  return (
    <li
      role="listitem"
      className={
        participant.isCurrentTurn
          ? 'bg-indigo-50 px-4 py-3 ring-1 ring-inset ring-indigo-200'
          : 'px-4 py-3'
      }
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          {participant.isCurrentTurn && (
            <div
              className="flex h-2 w-2 flex-shrink-0 items-center justify-center rounded-full ring-2 ring-indigo-400 ring-offset-1"
              aria-label="Currently speaking"
            >
              <PulseDot color="indigo" size="sm" />
            </div>
          )}
          <span
            className={
              participant.isCurrentTurn
                ? 'text-sm font-semibold text-indigo-900'
                : 'text-sm font-medium text-slate-900'
            }
          >
            {participant.personaRole}
          </span>
          {participant.isCurrentTurn && (
            <span
              className="flex items-center gap-1 rounded bg-indigo-100 px-1.5 py-0.5 text-[10px] font-bold uppercase text-indigo-700"
              aria-live="polite"
            >
              <PulseDot color="indigo" size="sm" />
              speaking…
            </span>
          )}
        </div>
        <span className="font-mono text-[10px] text-slate-500">
          {participant.tokensRemaining}/{totalBudget}
        </span>
      </div>
      <div
        className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={totalBudget}
        aria-valuenow={participant.tokensConsumed}
        aria-label={`${participant.personaRole} token budget`}
      >
        <div
          className={participant.isCurrentTurn ? 'h-full bg-indigo-500' : 'h-full bg-slate-300'}
          style={{ width: `${consumedPct}%` }}
        />
      </div>
    </li>
  )
}

// ---------------------------------------------------------------------------
// Icon helpers
// ---------------------------------------------------------------------------

function CheckCircleIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
      <polyline points="22 4 12 14.01 9 11.01" />
    </svg>
  )
}

function DocumentIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  )
}
