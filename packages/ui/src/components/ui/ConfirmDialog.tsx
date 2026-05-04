/**
 * ConfirmDialog — modal-backed confirmation for destructive or sensitive
 * actions. Replaces ad-hoc `window.confirm` and bespoke confirm modals.
 *
 * Modes:
 *   - default: just OK / Cancel
 *   - requireAcknowledge: "I understand…" checkbox must be ticked before
 *     the confirm button enables. Use for retire/rotate/destructive ops.
 *   - confirmText: user must type the literal string (e.g. the resource
 *     label) before the confirm button enables. Use for delete/revoke.
 */

import { ReactNode, useEffect, useId, useState } from 'react'
import { Modal } from './Modal.js'
import { Button } from './Button.js'
import { Input } from './Input.js'

interface ConfirmDialogProps {
  open: boolean
  onCancel: () => void
  onConfirm: () => void
  title: string
  body?: ReactNode
  /** Confirm button label. Defaults to "Confirm". */
  confirmLabel?: string
  /** Cancel button label. Defaults to "Cancel". */
  cancelLabel?: string
  /** Visual variant for the confirm button. */
  variant?: 'primary' | 'danger'
  /** Set true while the confirm action is in flight. Disables both buttons. */
  pending?: boolean
  /** Pending button text override. Defaults to "Working…". */
  pendingLabel?: string
  /** Server-side error to render inline. */
  error?: string | null
  /** Require an acknowledgement checkbox before enabling confirm. */
  requireAcknowledge?: string
  /** Require the user to type this exact string before enabling confirm. */
  confirmText?: string
}

export function ConfirmDialog({
  open,
  onCancel,
  onConfirm,
  title,
  body,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  variant = 'primary',
  pending = false,
  pendingLabel = 'Working…',
  error,
  requireAcknowledge,
  confirmText,
}: ConfirmDialogProps) {
  const [acknowledged, setAcknowledged] = useState(false)
  const [typed, setTyped] = useState('')
  const ackId = useId()
  const typedId = useId()

  // Reset state every time the dialog re-opens.
  useEffect(() => {
    if (open) {
      setAcknowledged(false)
      setTyped('')
    }
  }, [open])

  const ackOk = !requireAcknowledge || acknowledged
  const typedOk = !confirmText || typed === confirmText
  const canConfirm = !pending && ackOk && typedOk

  return (
    <Modal
      open={open}
      onClose={() => {
        if (!pending) onCancel()
      }}
      title={title}
    >
      <div className="space-y-4">
        {body && <div className="text-sm text-slate-700">{body}</div>}

        {confirmText && (
          <div>
            <label htmlFor={typedId} className="mb-1 block text-xs font-medium text-slate-700">
              Type{' '}
              <code className="rounded bg-slate-100 px-1 font-mono text-[11px]">{confirmText}</code>{' '}
              to confirm
            </label>
            <Input
              id={typedId}
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoFocus
              autoComplete="off"
              spellCheck={false}
            />
          </div>
        )}

        {requireAcknowledge && (
          <label htmlFor={ackId} className="flex items-start gap-2 text-xs text-slate-700">
            <input
              id={ackId}
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-0.5 h-4 w-4 rounded border-slate-300 text-brand-600 focus:ring-brand-500"
            />
            <span>{requireAcknowledge}</span>
          </label>
        )}

        {error && (
          <p
            className="rounded border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-700"
            role="alert"
          >
            {error}
          </p>
        )}

        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onCancel} disabled={pending}>
            {cancelLabel}
          </Button>
          <Button variant={variant} onClick={onConfirm} disabled={!canConfirm}>
            {pending ? pendingLabel : confirmLabel}
          </Button>
        </div>
      </div>
    </Modal>
  )
}
