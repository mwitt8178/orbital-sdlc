/**
 * DefectList — paginated defect list filtered by origin story.
 *
 * Round 4 additions:
 *   - "Reopen" button on closed defects.
 *     Opens a confirm modal → calls uat.ac.unmark on the linked AC (which
 *     effectively re-opens the defect path via the state machine).
 *
 * DEFERRED: defect.reopen dedicated tRPC procedure not in AppRouter.
 * The reopen flow calls uat.ac.unmark on the AC linked to the defect
 * as a workaround until defect.reopen is exposed.
 * If the defect has no linked ac_id, the Reopen button is disabled with
 * tooltip "No linked AC — backend defect.reopen procedure pending".
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { EmptyState } from '../../ui/EmptyState.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { Badge } from '../../ui/Badge.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'

interface DefectListProps {
  storyId: string
}

interface ReopenModalProps {
  defectKey: string
  /** null means no linked AC; button is disabled */
  linkedAcId: string | null
  sessionId: string | null
  onClose: () => void
}

function ReopenModal({ defectKey, linkedAcId, sessionId, onClose }: ReopenModalProps) {
  const utils = trpc.useUtils()

  const unmarkMutation = trpc.uat.ac.unmark.useMutation({
    onSuccess: () => {
      if (sessionId) void utils.uat.session.get.invalidate({ uat_session_id: sessionId })
      void utils.uat.defects.list.invalidate()
      onClose()
    },
  })

  const canReopen = !!linkedAcId && !!sessionId

  return (
    <Modal open onClose={onClose} title={`Reopen ${defectKey}`} width="max-w-sm">
      <div className="space-y-4">
        {!canReopen ? (
          <p className="text-sm text-slate-600">
            This defect has no linked acceptance criterion or session.{' '}
            <span className="text-amber-600">
              A dedicated defect.reopen backend procedure is pending.
            </span>
          </p>
        ) : (
          <p className="text-sm text-slate-700">
            Reopening this defect will reset the linked acceptance criterion to{' '}
            <strong>pending</strong> status. A new UAT session will be required to close it again.
          </p>
        )}

        {unmarkMutation.error && (
          <p className="text-xs text-rose-600" role="alert">
            {unmarkMutation.error.message}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={unmarkMutation.isPending}>
            Cancel
          </Button>
          <Button
            variant="danger"
            disabled={!canReopen || unmarkMutation.isPending}
            title={!canReopen ? 'Backend defect.reopen procedure pending' : undefined}
            onClick={() => {
              if (!linkedAcId || !sessionId) return
              unmarkMutation.mutate({
                uat_session_id: sessionId,
                ac_id: linkedAcId,
                justification: `User reopened defect ${defectKey} via UI`,
              })
            }}
          >
            {unmarkMutation.isPending ? 'Reopening…' : 'Confirm Reopen'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function DefectList({ storyId }: DefectListProps) {
  const [reopenDefect, setReopenDefect] = useState<{
    defectKey: string
    linkedAcId: string | null
    sessionId: string | null
  } | null>(null)

  const query = trpc.uat.defects.list.useQuery({
    origin_story_id: storyId,
    limit: 20,
  })

  if (query.isLoading) {
    return <Skeleton rows={3} />
  }
  if (query.error) {
    return <ErrorMessage title="Could not load defects" message={query.error.message} />
  }
  const items = query.data?.items ?? []
  if (items.length === 0) {
    return (
      <EmptyState
        title="No defects"
        description="Failed ACs become tracked defects and appear here."
      />
    )
  }
  return (
    <>
      <ul className="space-y-2" role="list">
        {items.map((d) => {
          const isClosed = d.state === 'closed' || d.state === 'resolved' || d.state === 'verified'
          return (
            <li
              key={d.defect_id}
              className="flex items-center justify-between rounded border border-slate-200 bg-white p-3"
              role="listitem"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="font-mono text-[10px] text-slate-500">{d.defect_key}</span>
                  <Badge
                    color={
                      d.severity === 'critical' || d.severity === 'high' ? 'rose' : 'amber'
                    }
                  >
                    {d.severity}
                  </Badge>
                  <Badge color="slate">{d.state}</Badge>
                </div>
                <p className="mt-0.5 truncate text-sm text-slate-900">{d.title}</p>
              </div>

              {isClosed && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() =>
                    setReopenDefect({
                      defectKey: d.defect_key,
                      // The tRPC list response doesn't include ac_id yet.
                      // DEFERRED: defect.reopen procedure would supply this.
                      linkedAcId: null,
                      sessionId: null,
                    })
                  }
                  aria-label={`Reopen defect ${d.defect_key}`}
                >
                  Reopen
                </Button>
              )}
            </li>
          )
        })}
      </ul>

      {reopenDefect && (
        <ReopenModal
          defectKey={reopenDefect.defectKey}
          linkedAcId={reopenDefect.linkedAcId}
          sessionId={reopenDefect.sessionId}
          onClose={() => setReopenDefect(null)}
        />
      )}
    </>
  )
}
