/**
 * CreateSprintModal — quick-create form for a new sprint in `planning` state.
 *
 * Inputs: name, story-point capacity, budget (USD cents → user enters dollars
 * for friendliness), optional wall-clock target (days). Calls sprint.create.
 */

import { useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { trpc } from '../../../services/trpc.js'
import { Modal } from '../../ui/Modal.js'
import { Button } from '../../ui/Button.js'
import { Input } from '../../ui/Input.js'
import { FormField } from '../../ui/FormField.js'
import { useToast } from '../../../services/use-toast.js'

interface CreateSprintModalProps {
  onClose: () => void
}

const schema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(120, 'Name is too long'),
  capacity: z.coerce.number().int().positive('Capacity must be greater than 0'),
  budgetUsd: z.coerce.number().positive('Budget must be greater than 0'),
  wallClockDays: z.coerce.number().int().min(0, 'Days must be 0 or more'),
})

type FormValues = z.infer<typeof schema>

export function CreateSprintModal({ onClose }: CreateSprintModalProps) {
  const utils = trpc.useUtils()
  const toast = useToast()
  const [serverError, setServerError] = useState<string | null>(null)

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: 'onBlur',
    defaultValues: { name: '', capacity: 20, budgetUsd: 50, wallClockDays: 5 },
  })

  const createMutation = trpc.sprint.create.useMutation({
    onSuccess: (_data, vars) => {
      toast.success('Sprint created', { description: vars.name })
      void utils.sprint.list.invalidate()
      onClose()
    },
    onError: (err) => {
      setServerError(err.message)
      toast.error('Could not create sprint', { description: err.message })
    },
  })

  const onSubmit = async (values: FormValues) => {
    setServerError(null)
    await createMutation.mutateAsync({
      name: values.name.trim(),
      story_point_capacity: values.capacity,
      budget_usd_cents: Math.round(values.budgetUsd * 100),
      wall_clock_target_ms:
        values.wallClockDays > 0 ? values.wallClockDays * 24 * 60 * 60 * 1000 : undefined,
    })
  }

  return (
    <Modal open onClose={onClose} title="Create sprint" width="max-w-md">
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        <FormField label="Name" error={errors.name?.message} required>
          <Input
            {...register('name')}
            placeholder="e.g. Sprint 14"
            autoFocus
            hasError={!!errors.name}
          />
        </FormField>

        <div className="grid grid-cols-2 gap-3">
          <FormField label="Capacity (story points)" error={errors.capacity?.message} required>
            <Input
              {...register('capacity')}
              type="number"
              min={1}
              hasError={!!errors.capacity}
            />
          </FormField>
          <FormField label="Budget (USD)" error={errors.budgetUsd?.message} required>
            <Input
              {...register('budgetUsd')}
              type="number"
              min={1}
              hasError={!!errors.budgetUsd}
            />
          </FormField>
        </div>

        <FormField
          label="Target duration (days)"
          error={errors.wallClockDays?.message}
          help="0 = no wall-clock target"
        >
          <Input
            {...register('wallClockDays')}
            type="number"
            min={0}
            hasError={!!errors.wallClockDays}
          />
        </FormField>

        {serverError && (
          <p
            className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
            role="alert"
          >
            {serverError}
          </p>
        )}

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <Button
            type="button"
            variant="secondary"
            onClick={onClose}
            disabled={isSubmitting || createMutation.isPending}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={isSubmitting || createMutation.isPending}>
            {isSubmitting || createMutation.isPending ? 'Creating…' : 'Create sprint'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
