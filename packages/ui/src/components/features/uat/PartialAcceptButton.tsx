/**
 * PartialAcceptButton — accepts a UAT session where at least one AC failed.
 *
 * Shown when the session is in submitted state and fail_count > 0.
 * Clicking opens a confirm modal before calling uat.accept with mode='partial'.
 *
 * The tRPC router's uat.accept handler already supports mode='partial'
 * (see uat.ts line ~313 — if (input.mode === 'partial') uatService.partialAccept).
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'

interface PartialAcceptButtonProps {
  sessionId: string
}

export function PartialAcceptButton({ sessionId }: PartialAcceptButtonProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const utils = trpc.useUtils()

  const acceptMutation = trpc.uat.accept.useMutation({
    onSuccess: () => {
      setConfirmOpen(false)
      void utils.uat.session.get.invalidate({ uat_session_id: sessionId })
    },
  })

  return (
    <>
      <Button
        variant="secondary"
        onClick={() => setConfirmOpen(true)}
        aria-label="Partially accept UAT session (some ACs failed)"
      >
        Partial Accept
      </Button>

      <Modal
        open={confirmOpen}
        onClose={() => setConfirmOpen(false)}
        title="Partial Accept"
        width="max-w-sm"
      >
        <div className="space-y-4">
          <p className="text-sm text-slate-700">
            You are accepting this session with one or more failed acceptance criteria. Passed ACs
            will be accepted; failed ACs will remain as tracked defects.
          </p>
          <p className="text-xs text-amber-700 rounded-md border border-amber-200 bg-amber-50 px-3 py-2">
            This action cannot be undone. Failed ACs must be resolved through a follow-up UAT
            session or defect reopen flow.
          </p>

          {acceptMutation.error && (
            <p className="text-xs text-rose-600" role="alert">
              {acceptMutation.error.message}
            </p>
          )}

          <div className="flex justify-end gap-2">
            <Button
              variant="secondary"
              onClick={() => setConfirmOpen(false)}
              disabled={acceptMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              onClick={() =>
                acceptMutation.mutate({
                  uat_session_id: sessionId,
                  mode: 'partial',
                  justification: 'User partially accepted UAT session via UI',
                })
              }
              disabled={acceptMutation.isPending}
            >
              {acceptMutation.isPending ? 'Accepting…' : 'Confirm Partial Accept'}
            </Button>
          </div>
        </div>
      </Modal>
    </>
  )
}
