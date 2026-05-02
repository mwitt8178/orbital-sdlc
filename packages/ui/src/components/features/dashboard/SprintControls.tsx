/**
 * SprintControls — Pause / Resume / Complete buttons for the active sprint.
 *
 * Affordances:
 *   - active   → Pause + Complete
 *   - paused   → Resume
 *   - else     → no buttons (panel collapses to nothing)
 *
 * Each action opens a confirmation Modal explaining the consequence.
 * Pause additionally captures a required reason. Mutations are wired to
 * the existing `sprint.pause / resume / complete` tRPC procedures and
 * invalidate `sprint.list` on success so the dashboard re-renders with
 * the new state.
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import type { Sprint } from '../../../store/sprints.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'

interface Props {
  sprint: Sprint
}

type Action = 'pause' | 'resume' | 'complete' | null

export function SprintControls({ sprint }: Props) {
  const utils = trpc.useUtils()
  const [open, setOpen] = useState<Action>(null)
  const [reason, setReason] = useState('')
  const [error, setError] = useState<string | null>(null)

  const closeModal = () => {
    setOpen(null)
    setReason('')
    setError(null)
  }

  const pauseMutation = trpc.sprint.pause.useMutation({
    onSuccess: () => {
      void utils.sprint.list.invalidate()
      closeModal()
    },
    onError: (err) => setError(err.message),
  })
  const resumeMutation = trpc.sprint.resume.useMutation({
    onSuccess: () => {
      void utils.sprint.list.invalidate()
      closeModal()
    },
    onError: (err) => setError(err.message),
  })
  const completeMutation = trpc.sprint.complete.useMutation({
    onSuccess: () => {
      void utils.sprint.list.invalidate()
      closeModal()
    },
    onError: (err) => setError(err.message),
  })

  const submit = () => {
    if (open === 'pause') {
      if (!reason.trim()) {
        setError('Pause reason is required.')
        return
      }
      pauseMutation.mutate({ sprint_id: sprint.id, reason: reason.trim() })
    } else if (open === 'resume') {
      resumeMutation.mutate({ sprint_id: sprint.id })
    } else if (open === 'complete') {
      completeMutation.mutate({ sprint_id: sprint.id })
    }
  }

  const inFlight =
    pauseMutation.isPending || resumeMutation.isPending || completeMutation.isPending

  if (sprint.status !== 'active' && sprint.status !== 'paused') {
    return null
  }

  return (
    <div className="flex items-center gap-2">
      {sprint.status === 'active' && (
        <>
          <Button
            variant="secondary"
            size="sm"
            onClick={() => setOpen('pause')}
            aria-label="Pause sprint"
          >
            <PauseIcon /> Pause
          </Button>
          <Button
            size="sm"
            onClick={() => setOpen('complete')}
            aria-label="Complete sprint"
          >
            <CheckIcon /> Complete
          </Button>
        </>
      )}
      {sprint.status === 'paused' && (
        <Button
          size="sm"
          onClick={() => setOpen('resume')}
          aria-label="Resume sprint"
        >
          <PlayIcon /> Resume
        </Button>
      )}

      <Modal
        open={open === 'pause'}
        onClose={closeModal}
        title="Pause this sprint?"
      >
        <p className="text-sm text-slate-600">
          Pausing freezes in-flight tasks. Worker capabilities are revoked
          and the DAG cursor is preserved so resuming picks up where it
          left off.
        </p>
        <label className="mt-3 block text-xs font-medium text-slate-700" htmlFor="pause-reason">
          Reason (required)
        </label>
        <textarea
          id="pause-reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          placeholder="e.g. Investigating elevated verifier failures"
          className="mt-1 w-full resize-none rounded-md border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
        />
        {error && (
          <p className="mt-2 text-xs text-rose-600" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={closeModal}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={inFlight || !reason.trim()}>
            {inFlight ? 'Pausing…' : 'Pause sprint'}
          </Button>
        </div>
      </Modal>

      <Modal
        open={open === 'resume'}
        onClose={closeModal}
        title="Resume this sprint?"
      >
        <p className="text-sm text-slate-600">
          Resuming re-issues capabilities to the workers that were active
          when the sprint paused and continues task execution from the
          saved DAG cursor.
        </p>
        {error && (
          <p className="mt-2 text-xs text-rose-600" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={closeModal}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={inFlight}>
            {inFlight ? 'Resuming…' : 'Resume sprint'}
          </Button>
        </div>
      </Modal>

      <Modal
        open={open === 'complete'}
        onClose={closeModal}
        title="Complete this sprint?"
      >
        <p className="text-sm text-slate-600">
          Completing closes the sprint. Any unfinished tasks remain in the
          backlog. This cannot be undone — you must explicitly start a new
          sprint to continue work.
        </p>
        {error && (
          <p className="mt-2 text-xs text-rose-600" role="alert">
            {error}
          </p>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={closeModal}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={inFlight}>
            {inFlight ? 'Completing…' : 'Complete sprint'}
          </Button>
        </div>
      </Modal>
    </div>
  )
}

function PauseIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="6" y="4" width="4" height="16" />
      <rect x="14" y="4" width="4" height="16" />
    </svg>
  )
}

function PlayIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
    >
      <path d="M8 5v14l11-7z" />
    </svg>
  )
}

function CheckIcon() {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M20 6 9 17l-5-5" />
    </svg>
  )
}
