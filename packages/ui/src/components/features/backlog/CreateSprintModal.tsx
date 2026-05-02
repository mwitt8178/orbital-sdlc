/**
 * CreateSprintModal — quick-create form for a new sprint in `planning` state.
 *
 * Inputs: name, story-point capacity, budget (USD cents → user enters dollars
 * for friendliness), optional wall-clock target (days). Calls sprint.create.
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Modal } from '../../ui/Modal.js'
import { Button } from '../../ui/Button.js'
import { Input } from '../../ui/Input.js'
import { useToast } from '../../../services/use-toast.js'

interface CreateSprintModalProps {
  onClose: () => void
}

export function CreateSprintModal({ onClose }: CreateSprintModalProps) {
  const utils = trpc.useUtils()
  const toast = useToast()

  const [name, setName] = useState('')
  const [capacity, setCapacity] = useState(20)
  const [budgetUsd, setBudgetUsd] = useState(50)
  const [wallClockDays, setWallClockDays] = useState(5)
  const [error, setError] = useState<string | null>(null)

  const createMutation = trpc.sprint.create.useMutation({
    onSuccess: () => {
      toast.success('Sprint created', { description: name })
      void utils.sprint.list.invalidate()
      onClose()
    },
    onError: (err) => {
      setError(err.message)
      toast.error('Could not create sprint', { description: err.message })
    },
  })

  const submit = () => {
    setError(null)
    if (!name.trim()) {
      setError('Name is required')
      return
    }
    if (capacity <= 0) {
      setError('Capacity must be positive')
      return
    }
    if (budgetUsd <= 0) {
      setError('Budget must be positive')
      return
    }

    createMutation.mutate({
      name: name.trim(),
      story_point_capacity: capacity,
      budget_usd_cents: Math.round(budgetUsd * 100),
      wall_clock_target_ms: wallClockDays > 0 ? wallClockDays * 24 * 60 * 60 * 1000 : undefined,
    })
  }

  return (
    <Modal open onClose={onClose} title="Create sprint" width="max-w-md">
      <div className="space-y-4">
        <div>
          <label htmlFor="sprint-name" className="mb-1 block text-xs font-medium text-slate-700">
            Name
          </label>
          <Input
            id="sprint-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Sprint 14"
            autoFocus
          />
        </div>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label htmlFor="sprint-capacity" className="mb-1 block text-xs font-medium text-slate-700">
              Capacity (story points)
            </label>
            <Input
              id="sprint-capacity"
              type="number"
              min={1}
              value={capacity}
              onChange={(e) => setCapacity(Number(e.target.value) || 0)}
            />
          </div>
          <div>
            <label htmlFor="sprint-budget" className="mb-1 block text-xs font-medium text-slate-700">
              Budget (USD)
            </label>
            <Input
              id="sprint-budget"
              type="number"
              min={1}
              value={budgetUsd}
              onChange={(e) => setBudgetUsd(Number(e.target.value) || 0)}
            />
          </div>
        </div>

        <div>
          <label htmlFor="sprint-days" className="mb-1 block text-xs font-medium text-slate-700">
            Target duration (days)
          </label>
          <Input
            id="sprint-days"
            type="number"
            min={0}
            value={wallClockDays}
            onChange={(e) => setWallClockDays(Number(e.target.value) || 0)}
          />
        </div>

        {error && <p className="text-xs text-rose-600">{error}</p>}

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <Button variant="secondary" onClick={onClose} disabled={createMutation.isPending}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={createMutation.isPending || !name.trim()}>
            {createMutation.isPending ? 'Creating…' : 'Create sprint'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
