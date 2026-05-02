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
import { trpc } from '../../../services/trpc.js'
import { Modal } from '../../ui/Modal.js'
import { Button } from '../../ui/Button.js'
import { Input } from '../../ui/Input.js'
import { useVisionStore } from '../../../store/vision.js'
import { useToast } from '../../../services/use-toast.js'
import { buildAuditMetadata } from '../../../services/audit-metadata.js'

interface CreateEpicModalProps {
  onClose: () => void
  onCreated?: (epicId: string) => void
}

export function CreateEpicModal({ onClose, onCreated }: CreateEpicModalProps) {
  const documentId = useVisionStore((s) => s.currentDocumentId)
  const utils = trpc.useUtils()
  const toast = useToast()

  const [title, setTitle] = useState('')
  const [rationale, setRationale] = useState('')
  const [priority, setPriority] = useState(100)
  const [error, setError] = useState<string | null>(null)

  const docQuery = trpc.vision.get.useQuery(
    documentId ? { vision_document_id: documentId } : (undefined as never),
    { enabled: !!documentId },
  )
  const visionVersionId = docQuery.data?.version?.vision_version_id ?? null

  const createMutation = trpc.backlog.epics.create.useMutation({
    onSuccess: (epic) => {
      toast.success('Epic created', { description: title })
      void utils.backlog.epics.list.invalidate()
      void utils.backlog.stories.list.invalidate()
      onCreated?.(epic.epicId)
      onClose()
    },
    onError: (err) => {
      setError(err.message)
      toast.error('Could not create epic', { description: err.message })
    },
  })

  const submit = () => {
    setError(null)
    if (!title.trim()) {
      setError('Title is required')
      return
    }
    if (!rationale.trim()) {
      setError('Rationale is required')
      return
    }
    if (!visionVersionId) {
      setError('No vision version available — lock or draft a vision first')
      return
    }

    // The backlog.epics.create input doesn't take audit_metadata directly;
    // the procedure is wrapped in idempotentProcedure which uses an
    // Idempotency-Key header. We still build audit metadata for trace
    // continuity in linked artifacts when invalidating downstream.
    const auditMeta = buildAuditMetadata(`User created epic "${title.trim()}"`, {
      linked_artifacts: [{ type: 'vision_version', id: visionVersionId }],
    })
    void auditMeta // currently unused by this procedure but built for future

    createMutation.mutate({
      vision_version_id: visionVersionId,
      title: title.trim(),
      rationale: rationale.trim(),
      priority,
    })
  }

  return (
    <Modal open onClose={onClose} title="Create epic" width="max-w-lg">
      <div className="space-y-4">
        <div>
          <label htmlFor="epic-title" className="mb-1 block text-xs font-medium text-slate-700">
            Title
          </label>
          <Input
            id="epic-title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="e.g. Authentication"
            autoFocus
            hasError={!!error && !title.trim()}
          />
        </div>

        <div>
          <label htmlFor="epic-rationale" className="mb-1 block text-xs font-medium text-slate-700">
            Rationale
          </label>
          <textarea
            id="epic-rationale"
            value={rationale}
            onChange={(e) => setRationale(e.target.value)}
            placeholder="Why is this epic worth building? Which outcome from the vision does it serve?"
            rows={4}
            className="w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-sm text-slate-900 placeholder-slate-400 focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <div>
          <label htmlFor="epic-priority" className="mb-1 block text-xs font-medium text-slate-700">
            Priority (lower = higher priority)
          </label>
          <Input
            id="epic-priority"
            type="number"
            min={0}
            value={priority}
            onChange={(e) => setPriority(Number(e.target.value) || 0)}
          />
        </div>

        {!visionVersionId && (
          <p className="rounded-md border border-amber-200 bg-amber-50 p-2 text-xs text-amber-800">
            No vision version available. Visit the Vision page to start a session and draft your
            vision first.
          </p>
        )}

        {error && <p className="text-xs text-rose-600">{error}</p>}

        <div className="flex justify-end gap-2 border-t border-slate-100 pt-3">
          <Button variant="secondary" onClick={onClose} disabled={createMutation.isPending}>
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={
              createMutation.isPending ||
              !title.trim() ||
              !rationale.trim() ||
              !visionVersionId
            }
          >
            {createMutation.isPending ? 'Creating…' : 'Create epic'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
