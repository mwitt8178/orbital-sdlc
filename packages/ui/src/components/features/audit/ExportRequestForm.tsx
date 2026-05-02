/**
 * ExportRequestForm — request a new audit export package.
 *
 * Date range + passphrase prompt. Passphrase is sent in the mutation but is
 * NEVER logged or stored in any client-side state beyond the in-flight mutation.
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { useToast } from '../../../services/use-toast.js'

function isoMidnight(date: Date): string {
  const d = new Date(date)
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString()
}

const DEFAULT_RANGE_DAYS = 30

function defaultStart(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - DEFAULT_RANGE_DAYS)
  return isoMidnight(d)
}

function defaultEnd(): string {
  const d = new Date()
  d.setUTCHours(0, 0, 0, 0)
  return d.toISOString()
}

export function ExportRequestForm({
  onRequested,
}: {
  onRequested: (exportId: string) => void
}) {
  const [open, setOpen] = useState(false)
  const [rangeStart, setRangeStart] = useState(defaultStart())
  const [rangeEnd, setRangeEnd] = useState(defaultEnd())
  const [passphrase, setPassphrase] = useState('')
  const [justification, setJustification] = useState('')
  const [error, setError] = useState<string | null>(null)
  const utils = trpc.useUtils()
  const toast = useToast()

  const mutation = trpc.auditExport.export.request.useMutation({
    onSuccess: (data) => {
      onRequested(data.export_id)
      setPassphrase('')
      setOpen(false)
      void utils.auditExport.export.list.invalidate()
      toast.success('Export queued', {
        description: `Export id ${data.export_id.slice(0, 8)} — track progress in Recent exports.`,
      })
    },
    onError: (err) => {
      setError(err.message)
      toast.error('Could not request export', { description: err.message })
    },
  })

  const submit = () => {
    if (passphrase.length < 12) {
      setError('Passphrase must be at least 12 characters')
      return
    }
    if (!justification.trim()) {
      setError('Justification is required')
      return
    }
    setError(null)
    mutation.mutate({
      range_start: rangeStart,
      range_end: rangeEnd,
      scope: { kind: 'full_org' },
      justification: justification.trim(),
      passphrase,
    })
  }

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => setOpen(true)}
        aria-label="Request audit export"
      >
        Export
      </Button>

      <Modal open={open} onClose={() => setOpen(false)} title="Request audit export">
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-700" htmlFor="export-from">
              Range start
            </label>
            <input
              id="export-from"
              type="datetime-local"
              value={toLocalInput(rangeStart)}
              onChange={(e) => setRangeStart(fromLocalInput(e.target.value))}
              className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700" htmlFor="export-to">
              Range end
            </label>
            <input
              id="export-to"
              type="datetime-local"
              value={toLocalInput(rangeEnd)}
              onChange={(e) => setRangeEnd(fromLocalInput(e.target.value))}
              className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700" htmlFor="export-pass">
              Passphrase (encrypts package, min 12 chars)
            </label>
            <input
              id="export-pass"
              type="password"
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="new-password"
              className="mt-1 w-full rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              aria-required
            />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-700" htmlFor="export-just">
              Justification
            </label>
            <textarea
              id="export-just"
              value={justification}
              onChange={(e) => setJustification(e.target.value)}
              rows={2}
              className="mt-1 w-full resize-none rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
            />
          </div>
          {error && (
            <p className="text-xs text-rose-600" role="alert">
              {error}
            </p>
          )}
          <div className="flex justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={submit} disabled={mutation.isPending}>
              {mutation.isPending ? 'Requesting…' : 'Request export'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}

function toLocalInput(iso: string): string {
  // datetime-local expects YYYY-MM-DDTHH:mm (no timezone, no seconds)
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n: number) => n.toString().padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function fromLocalInput(value: string): string {
  if (!value) return ''
  const d = new Date(value)
  if (Number.isNaN(d.getTime())) return ''
  return d.toISOString()
}
