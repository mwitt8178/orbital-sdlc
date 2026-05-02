/**
 * VisionHistoryPanel — chronological list of versions for a vision document.
 *
 * Reads vision.history(documentId). Each row shows the version number, lock
 * status, and the timestamp. Clicking a row opens a read-only modal that
 * fetches that exact version via vision.get(documentId, version_number).
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { useVisionStore } from '../../../store/vision.js'
import { Modal } from '../../ui/Modal.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { EmptyState } from '../../ui/EmptyState.js'

export function VisionHistoryPanel() {
  const documentId = useVisionStore((s) => s.currentDocumentId)
  const [openVersion, setOpenVersion] = useState<number | null>(null)

  const historyQuery = trpc.vision.history.useQuery(
    documentId ? { vision_document_id: documentId, limit: 50 } : (undefined as never),
    { enabled: !!documentId },
  )

  if (!documentId) {
    return null
  }

  return (
    <aside className="rounded-lg border border-slate-200 bg-white">
      <header className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
        <h3 className="text-sm font-semibold text-slate-900">Version history</h3>
        {historyQuery.data?.items && (
          <span className="text-xs text-slate-500">
            {historyQuery.data.items.length} version
            {historyQuery.data.items.length === 1 ? '' : 's'}
          </span>
        )}
      </header>

      <div className="max-h-72 overflow-y-auto">
        {historyQuery.isLoading ? (
          <div className="px-4 py-3">
            <Skeleton rows={3} />
          </div>
        ) : historyQuery.error ? (
          <div className="px-4 py-3">
            <ErrorMessage title="Could not load history" message={historyQuery.error.message} />
          </div>
        ) : !historyQuery.data?.items || historyQuery.data.items.length === 0 ? (
          <div className="px-4 py-3">
            <EmptyState
              title="No versions yet"
              description="Locked versions will appear here as the vision evolves."
            />
          </div>
        ) : (
          <ul className="divide-y divide-slate-100">
            {historyQuery.data.items.map((v) => {
              const row = v as Record<string, unknown>
              const versionNumber = Number(row['version_number'] ?? row['versionNumber'] ?? 0)
              const isLocked = !!(row['is_locked'] ?? row['isLocked'])
              const lockedAt = (row['locked_at'] ?? row['lockedAt']) as string | null | undefined
              const createdAt = (row['created_at'] ?? row['createdAt']) as string | null | undefined
              const ts = lockedAt ?? createdAt ?? null

              // Negative version numbers are PM-stub draft sentinels per
              // Phase 4A's storage convention. Render them as "Draft" with no
              // confusing negative number; locked versions show "v1", "v2"…
              const isDraft = versionNumber < 0 || !isLocked
              const label = isDraft ? 'Draft' : `v${versionNumber}`
              return (
                <li key={versionNumber}>
                  <button
                    type="button"
                    onClick={() => setOpenVersion(versionNumber)}
                    className="flex w-full items-center justify-between px-4 py-2.5 text-left transition hover:bg-slate-50 focus-visible:bg-slate-50 focus-visible:outline-none"
                    aria-label={`Open ${label}`}
                  >
                    <div>
                      <div className="text-sm font-medium text-slate-900">
                        {label}{' '}
                        {isLocked ? (
                          <span className="ml-1 inline-flex items-center gap-1 rounded-full bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">
                            locked
                          </span>
                        ) : null}
                      </div>
                      {ts && (
                        <div className="text-xs text-slate-500">{formatTimestamp(ts)}</div>
                      )}
                    </div>
                    <span className="text-slate-400" aria-hidden="true">
                      ›
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}
      </div>

      {openVersion !== null && (
        <VersionViewerModal
          documentId={documentId}
          versionNumber={openVersion}
          onClose={() => setOpenVersion(null)}
        />
      )}
    </aside>
  )
}

function VersionViewerModal({
  documentId,
  versionNumber,
  onClose,
}: {
  documentId: string
  versionNumber: number
  onClose: () => void
}) {
  const versionQuery = trpc.vision.get.useQuery({
    vision_document_id: documentId,
    version_number: versionNumber,
  })

  return (
    <Modal open onClose={onClose} title={`Version ${versionNumber}`} width="max-w-2xl">
      {versionQuery.isLoading ? (
        <Skeleton rows={5} />
      ) : versionQuery.error ? (
        <ErrorMessage title="Could not load version" message={versionQuery.error.message} />
      ) : !versionQuery.data?.version ? (
        <EmptyState
          title="Version unavailable"
          description="This version cannot be loaded right now."
        />
      ) : (
        <ReadonlyVersionView content={versionQuery.data.version.content as Record<string, unknown>} />
      )}
    </Modal>
  )
}

function ReadonlyVersionView({ content }: { content: Record<string, unknown> }) {
  const title = String(content['title'] ?? '')
  const summary = String(content['summary'] ?? '')
  const goals = ((content['goals'] as Array<Record<string, unknown>>) ?? []).map((g) =>
    String(g['text'] ?? ''),
  )
  const nonGoals = ((content['non_goals'] as Array<Record<string, unknown>>) ?? []).map((g) =>
    String(g['text'] ?? ''),
  )
  return (
    <div className="space-y-4">
      {title && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Title
          </div>
          <p className="mt-1 text-sm font-semibold text-slate-900">{title}</p>
        </div>
      )}
      {summary && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Summary
          </div>
          <p className="mt-1 text-sm text-slate-700">{summary}</p>
        </div>
      )}
      {goals.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Goals
          </div>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-slate-700">
            {goals.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </div>
      )}
      {nonGoals.length > 0 && (
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-slate-400">
            Non-goals
          </div>
          <ul className="mt-1 list-disc space-y-1 pl-4 text-sm text-slate-700">
            {nonGoals.map((g, i) => (
              <li key={i}>{g}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso)
    if (Number.isNaN(d.getTime())) return iso
    return d.toLocaleString()
  } catch {
    return iso
  }
}
