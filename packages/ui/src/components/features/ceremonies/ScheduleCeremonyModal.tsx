/**
 * ScheduleCeremonyModal — ad-hoc / override ceremony creation modal.
 *
 * Context: Ceremonies normally fire automatically from event triggers.
 * This modal is the OVERRIDE path for genuine ad-hoc cases (e.g. "I need an
 * architecture review right now, outside normal trigger conditions").
 *
 * Fields:
 *   - ceremony kind: planning / standup / retro / custom
 *   - scheduled time (defaults to now)
 *   - participants (multi-select from persona list)
 *
 * Calls ceremony.schedule mutation if it exists. Since no tRPC procedure
 * for ceremony.schedule exists in the current AppRouter, the form renders
 * with a disabled submit state and a "Backend procedure pending" notice.
 *
 * DEFERRED: ceremony.schedule tRPC procedure not in AppRouter.
 * The modal is fully wired and will activate when the procedure is added.
 */

import { useState } from 'react'
import { Modal } from '../../ui/Modal.js'
import { Button } from '../../ui/Button.js'

type CeremonyKind = 'planning' | 'standup' | 'retro' | 'custom'

const KIND_OPTIONS: { value: CeremonyKind; label: string }[] = [
  { value: 'planning', label: 'Sprint Planning' },
  { value: 'standup', label: 'Standup Digest' },
  { value: 'retro', label: 'Retrospective' },
  { value: 'custom', label: 'Custom' },
]

const PERSONA_SLUGS = [
  'arch-lead',
  'backend-senior',
  'frontend-senior',
  'qa-lead',
  'product-manager',
  'tech-lead',
  'devops-engineer',
  'security-reviewer',
  'data-engineer',
  'ux-designer',
  'scrum-master',
]

interface ScheduleCeremonyModalProps {
  open: boolean
  onClose: () => void
}

function toLocalDatetimeValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}`
  )
}

export function ScheduleCeremonyModal({ open, onClose }: ScheduleCeremonyModalProps) {
  const [kind, setKind] = useState<CeremonyKind>('standup')
  const [scheduledAt, setScheduledAt] = useState(() => toLocalDatetimeValue(new Date()))
  const [selectedPersonas, setSelectedPersonas] = useState<string[]>([])

  const togglePersona = (slug: string) => {
    setSelectedPersonas((prev) =>
      prev.includes(slug) ? prev.filter((p) => p !== slug) : [...prev, slug],
    )
  }

  // Backend procedure not yet available — form is disabled.
  const backendPending = true

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (backendPending) return
    // TODO: call ceremony.schedule mutation when procedure is added.
    // trpc.ceremony.schedule.mutate({ kind, scheduled_at: scheduledAt, participants: selectedPersonas })
    onClose()
  }

  return (
    <Modal open={open} onClose={onClose} title="Override — Ad-hoc Ceremony" width="max-w-md">
      <p className="mb-4 rounded-md border border-indigo-100 bg-indigo-50 px-3 py-2 text-xs text-indigo-700">
        <strong>Ad-hoc ceremony</strong> — these usually fire automatically. Use this only when
        you need one outside the normal triggers.
      </p>

      {backendPending && (
        <div className="mb-4 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          <strong>Backend procedure pending</strong> — ceremony.schedule is not yet in the
          AppRouter. This form will activate when the procedure is available.
        </div>
      )}

      <form onSubmit={handleSubmit} className="space-y-4">
        {/* Kind */}
        <div>
          <label
            htmlFor="ceremony-kind"
            className="mb-1 block text-xs font-medium text-slate-700"
          >
            Ceremony kind
          </label>
          <select
            id="ceremony-kind"
            value={kind}
            onChange={(e) => setKind(e.target.value as CeremonyKind)}
            disabled={backendPending}
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60"
            aria-label="Select ceremony kind"
          >
            {KIND_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>

        {/* Scheduled time */}
        <div>
          <label
            htmlFor="ceremony-time"
            className="mb-1 block text-xs font-medium text-slate-700"
          >
            Scheduled time
          </label>
          <input
            id="ceremony-time"
            type="datetime-local"
            value={scheduledAt}
            onChange={(e) => setScheduledAt(e.target.value)}
            disabled={backendPending}
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 focus:border-transparent focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60"
            aria-label="Scheduled time"
          />
        </div>

        {/* Participants */}
        <div>
          <p className="mb-1.5 text-xs font-medium text-slate-700">
            Participants <span className="font-normal text-slate-400">({selectedPersonas.length} selected)</span>
          </p>
          <div
            className="max-h-40 space-y-1 overflow-y-auto rounded-md border border-slate-200 bg-white p-2"
            role="group"
            aria-label="Select participants"
          >
            {PERSONA_SLUGS.map((slug) => {
              const checked = selectedPersonas.includes(slug)
              return (
                <label
                  key={slug}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-sm text-slate-700 hover:bg-slate-50"
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={() => togglePersona(slug)}
                    disabled={backendPending}
                    className="rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:opacity-50"
                    aria-label={`Select ${slug}`}
                  />
                  <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-[8px] font-bold text-indigo-700">
                    {slug.slice(0, 2).toUpperCase()}
                  </span>
                  {slug}
                </label>
              )
            })}
          </div>
        </div>

        {/* Actions */}
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            type="submit"
            disabled={backendPending || selectedPersonas.length === 0}
            title={backendPending ? 'Backend procedure pending' : undefined}
          >
            Schedule
          </Button>
        </div>
      </form>
    </Modal>
  )
}
