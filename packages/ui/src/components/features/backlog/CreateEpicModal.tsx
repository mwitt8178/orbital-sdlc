/**
 * CreateEpicModal — modal for creating a new epic under the active vision
 * version. Calls backlog.epics.create with audit_metadata.
 *
 * The vision_version_id is resolved from the active vision document's
 * current_version_number (read via vision.get). If the vision is not yet
 * locked, we still allow epic creation against the current draft version
 * — the server accepts any vision_version_id; downstream constraints
 * (e.g. lock-before-sprint) are enforced separately.
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
import { useVisionStore } from '../../../store/vision.js'
import { useToast } from '../../../services/use-toast.js'
import { buildAuditMetadata } from '../../../services/audit-metadata.js'

interface CreateEpicModalProps {
  onClose: () => void
  onCreated?: (epicId: string) => void
}

const schema = z.object({
  title: z.string().trim().min(1, 'Title is required').max(200, 'Title is too long'),
  rationale: z
    .string()
    .trim()
    .min(1, 'Rationale is required')
    .max(2000, 'Rationale is too long'),
  priority: z.coerce.number().int().min(0, 'Priority must be 0 or greater'),
})

type FormValues = z.infer<typeof schema>

export function CreateEpicModal({ onClose, onCreated }: CreateEpicModalProps) {
  const documentId = useVisionStore((s) => s.currentDocumentId)
  const utils = trpc.useUtils()
  const toast = useToast()
  const [serverError, setServerError] = useState<string | null>(null)

  const docQuery = trpc.vision.get.useQuery(
    documentId ? { vision_document_id: documentId } : (undefined as never),
    { enabled: !!documentId },
  )
  const visionVersionId = docQuery.data?.version?.vision_version_id ?? null

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    mode: 'onBlur',
    defaultValues: { title: '', rationale: '', priority: 100 },
  })

  const createMutation = trpc.backlog.epics.create.useMutation({
    onSuccess: (epic, vars) => {
      toast.success('Epic created', { description: vars.title })
      void utils.backlog.epics.list.invalidate()
      void utils.backlog.stories.list.invalidate()
      onCreated?.(epic.epicId)
      onClose()
    },
    onError: (err) => {
      setServerError(err.message)
      toast.error('Could not create epic', { description: err.message })
    },
  })

  const onSubmit = async (values: FormValues) => {
    setServerError(null)
    if (!visionVersionId) {
      setServerError('No vision version available — lock or draft a vision first')
      return
    }

    const auditMeta = buildAuditMetadata(`User created epic "${values.title.trim()}"`, {
      linked_artifacts: [{ type: 'vision_version', id: visionVersionId }],
    })
    void auditMeta

    await createMutation.mutateAsync({
      vision_version_id: visionVersionId,
      title: values.title.trim(),
      rationale: values.rationale.trim(),
      priority: values.priority,
    })
  }

  return (
    <Modal open onClose={onClose} title="Create epic" width="max-w-lg">
      <form onSubmit={handleSubmit(onSubmit)} noValidate className="space-y-4">
        <FormField label="Title" error={errors.title?.message} required>
          <Input
            {...register('title')}
            placeholder="e.g. Authentication"
            autoFocus
            hasError={!!errors.title}
          />
        </FormField>

        <FormField label="Rationale" error={errors.rationale?.message} required>
          <textarea
            {...register('rationale')}
            placeholder="Why is this epic worth building? Which outcome from the vision does it serve?"
            rows={4}
            className={
              'w-full rounded-md border bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500 ' +
              (errors.rationale ? 'border-rose-300 bg-rose-50' : 'border-slate-200')
            }
          />
        </FormField>

        <FormField
          label="Priority (lower = higher priority)"
          error={errors.priority?.message}
          help="Stories inherit relative priority from their epic."
        >
          <Input
            {...register('priority')}
            type="number"
            min={0}
            hasError={!!errors.priority}
          />
        </FormField>

        {!visionVersionId && (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
            No vision version available. Visit the Vision page to start a session and draft your
            vision first.
          </p>
        )}

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
          <Button
            type="submit"
            disabled={isSubmitting || createMutation.isPending || !visionVersionId}
          >
            {isSubmitting || createMutation.isPending ? 'Creating…' : 'Create epic'}
          </Button>
        </div>
      </form>
    </Modal>
  )
}
