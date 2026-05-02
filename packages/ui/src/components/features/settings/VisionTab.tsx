/**
 * VisionTab — vision summary and navigation affordances in Settings.
 *
 * Shows the currently locked vision document (read-only) with version
 * metadata. Provides entry points to:
 *   - /vision (Revise flow on the locked document)
 *   - /vision (Create new, only when user confirms the intent)
 *
 * If no vision document is active in the store, renders a prompt to
 * navigate to /vision to create one.
 */

import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { trpc } from '../../../services/trpc.js'
import { useVisionStore } from '../../../store/vision.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'

export function VisionTab() {
  const navigate = useNavigate()
  const documentId = useVisionStore((s) => s.currentDocumentId)
  const [confirmNewOpen, setConfirmNewOpen] = useState(false)

  const docQuery = trpc.vision.get.useQuery(
    documentId ? { vision_document_id: documentId } : (undefined as never),
    { enabled: !!documentId },
  )

  const historyQuery = trpc.vision.history.useQuery(
    documentId ? { vision_document_id: documentId } : (undefined as never),
    { enabled: !!documentId },
  )

  if (!documentId) {
    return (
      <div className="space-y-4">
        <Description />
        <div className="rounded-lg border border-slate-200 bg-white px-4 py-6 text-center">
          <p className="text-sm text-slate-500">No vision document is active for this project.</p>
          <div className="mt-4">
            <Button onClick={() => navigate('/vision')}>Go to Vision</Button>
          </div>
        </div>
      </div>
    )
  }

  if (docQuery.isLoading) {
    return (
      <div className="space-y-4">
        <Description />
        <Skeleton rows={4} />
      </div>
    )
  }

  if (docQuery.error) {
    return (
      <div className="space-y-4">
        <Description />
        <ErrorMessage title="Could not load vision" message={docQuery.error.message} />
      </div>
    )
  }

  const doc = docQuery.data
  const version = doc?.version ?? null
  const isLocked = version?.is_locked ?? false
  const content = version?.content as Record<string, unknown> | null | undefined
  const title = (content?.['title'] as string | undefined) ?? '(Untitled)'
  const summary = (content?.['summary'] as string | undefined) ?? null

  const lockedAt = version?.locked_at
    ? new Date(version.locked_at as string).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      })
    : null

  const versionNumber = version?.version_number ?? null

  const historyItems = historyQuery.data?.items ?? []

  return (
    <div className="space-y-4">
      <Description />

      {/* Current locked vision */}
      <section className="rounded-lg border border-slate-200 bg-white">
        <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-900">Current vision</h3>
          {isLocked && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-50 px-2.5 py-1 text-xs font-medium text-emerald-700">
              <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-500" aria-hidden="true" />
              Locked
            </span>
          )}
          {!isLocked && version && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700">
              Draft
            </span>
          )}
        </header>
        <div className="divide-y divide-slate-50 px-4 py-3 text-sm">
          <Row label="Title" value={title} />
          {versionNumber !== null && <Row label="Version" value={`v${versionNumber}`} />}
          {lockedAt && <Row label="Locked at" value={lockedAt} />}
          {summary && (
            <div className="py-2">
              <span className="block text-xs text-slate-500">Summary</span>
              <p className="mt-1 text-sm text-slate-800">{summary}</p>
            </div>
          )}
        </div>
      </section>

      {/* Version history */}
      {historyItems.length > 0 && (
        <section className="rounded-lg border border-slate-200 bg-white">
          <header className="border-b border-slate-100 px-4 py-3">
            <h3 className="text-sm font-semibold text-slate-900">Version history</h3>
          </header>
          <ul className="divide-y divide-slate-100">
            {historyItems.slice(0, 5).map((v) => {
              const vContent = v.content as Record<string, unknown> | null | undefined
              const vTitle = (vContent?.['title'] as string | undefined) ?? '(Untitled)'
              const vLockedAt = v.locked_at
                ? new Date(v.locked_at as string).toLocaleDateString(undefined, {
                    year: 'numeric',
                    month: 'short',
                    day: 'numeric',
                  })
                : null
              return (
                <li
                  key={v.vision_version_id}
                  className="flex items-center justify-between gap-4 px-4 py-3 text-sm"
                >
                  <div className="min-w-0">
                    <span className="font-medium text-slate-900">v{v.version_number}</span>
                    <span className="ml-2 truncate text-slate-500">{vTitle}</span>
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-3 text-xs text-slate-400">
                    {vLockedAt && <span>{vLockedAt}</span>}
                    {v.is_locked && (
                      <span className="inline-block h-1.5 w-1.5 rounded-full bg-emerald-400" aria-hidden="true" />
                    )}
                  </div>
                </li>
              )
            })}
          </ul>
          <div className="border-t border-slate-100 px-4 py-2.5">
            <button
              type="button"
              onClick={() => navigate('/vision')}
              className="text-xs text-brand-600 hover:text-brand-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            >
              View full history in Vision panel →
            </button>
          </div>
        </section>
      )}

      {/* Actions */}
      <section className="flex flex-col gap-3 sm:flex-row">
        <Button
          onClick={() => navigate('/vision')}
          aria-label="Go to Vision page to revise the current vision"
        >
          Revise vision
        </Button>
        <Button
          variant="secondary"
          onClick={() => setConfirmNewOpen(true)}
          aria-label="Create a new vision document"
        >
          Create new vision
        </Button>
      </section>

      {/* Confirm: create new vision */}
      <Modal
        open={confirmNewOpen}
        onClose={() => setConfirmNewOpen(false)}
        title="Create a new vision?"
      >
        <p className="text-sm text-slate-600">
          Most projects have one vision. Create a new one only if you&apos;re starting a
          fundamentally different product.
        </p>
        <p className="mt-2 text-sm text-slate-500">
          Your existing vision document and its history will not be deleted — they remain accessible
          from the Vision page.
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmNewOpen(false)}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setConfirmNewOpen(false)
              navigate('/vision')
            }}
          >
            Yes, create new
          </Button>
        </div>
      </Modal>
    </div>
  )
}

function Description() {
  return (
    <p className="text-sm text-slate-500">
      Your vision is rarely changed. Most updates happen through{' '}
      <strong className="font-medium text-slate-700">Revise</strong>. Create a new one only when
      starting a fundamentally different product.
    </p>
  )
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-2">
      <span className="text-xs text-slate-500">{label}</span>
      <span className="text-sm text-slate-800">{value}</span>
    </div>
  )
}
