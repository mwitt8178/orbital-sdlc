/**
 * VisionSummaryHeader — collapsible summary of the locked vision document at
 * the top of /backlog. Shows the title, locked-version badge, and a Revise/View
 * link to /vision. If no document is selected (currentDocumentId is null),
 * renders the "Lock your vision first" CTA.
 */

import { useState } from 'react'
import { Link } from 'react-router-dom'
import { trpc } from '../../../services/trpc.js'
import { useVisionStore } from '../../../store/vision.js'
import { Badge } from '../../ui/Badge.js'
import { Skeleton } from '../../ui/Skeleton.js'

export function VisionSummaryHeader() {
  const documentId = useVisionStore((s) => s.currentDocumentId)
  const [open, setOpen] = useState(true)

  const docQuery = trpc.vision.get.useQuery(
    documentId ? { vision_document_id: documentId } : (undefined as never),
    { enabled: !!documentId, staleTime: 60_000 },
  )

  if (!documentId) {
    return (
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-4">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-md bg-amber-100 text-amber-700">
            <EyeIcon />
          </div>
          <div className="flex-1">
            <p className="text-sm font-semibold text-amber-900">
              Lock your vision first to define what you&apos;re building
            </p>
            <p className="mt-1 text-xs text-amber-800">
              Every epic, story, and AC traces back to a locked vision document. Visit{' '}
              <Link
                to="/vision"
                className="font-medium underline underline-offset-2 hover:text-amber-900"
              >
                Vision
              </Link>{' '}
              to start an intake session, draft, and lock v1.
            </p>
          </div>
        </div>
      </div>
    )
  }

  if (docQuery.isLoading) {
    return (
      <div className="rounded-lg border border-slate-200 bg-white p-4">
        <Skeleton rows={2} />
      </div>
    )
  }

  if (docQuery.error || !docQuery.data) {
    return (
      <div className="rounded-lg border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
        Could not load vision summary: {docQuery.error?.message ?? 'unknown error'}
      </div>
    )
  }

  const doc = docQuery.data
  const isLocked = doc.lifecycle_state === 'locked' || doc.lifecycle_state === 'revised'
  const versionLabel = doc.version?.is_locked
    ? `v${doc.version.version_number}`
    : doc.version
      ? `draft v${doc.version.version_number}`
      : 'draft'
  const visionTitle =
    typeof doc.version?.content === 'object' &&
    doc.version?.content !== null &&
    'title' in (doc.version.content as Record<string, unknown>)
      ? String((doc.version.content as Record<string, unknown>)['title'] ?? 'Vision')
      : 'Vision'

  return (
    <div className="rounded-lg border border-slate-200 bg-white">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="flex w-full items-center gap-2 px-4 py-3 text-left hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
      >
        <ChevronIcon open={open} />
        <span className="text-xs font-semibold uppercase tracking-wider text-slate-500">
          Vision
        </span>
        <span className="font-medium text-slate-900" data-testid="vision-summary-title">
          &ldquo;{visionTitle}&rdquo;
        </span>
        {isLocked ? (
          <Badge color="emerald">locked {versionLabel}</Badge>
        ) : (
          <Badge color="amber">{versionLabel}</Badge>
        )}
        <span className="ml-auto flex items-center gap-2">
          <Link
            to="/vision"
            onClick={(e) => e.stopPropagation()}
            className="rounded border border-slate-200 px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
          >
            {isLocked ? 'Revise' : 'View'}
          </Link>
        </span>
      </button>

      {open && doc.version && (
        <div className="border-t border-slate-100 px-4 py-3 text-xs text-slate-600">
          <VisionContent content={doc.version.content as Record<string, unknown>} />
        </div>
      )}
    </div>
  )
}

interface VisionContentLike {
  problem?: string
  audience?: string
  outcomes?: string[]
  success_metrics?: Array<string | { name?: string; target?: string }>
}

function VisionContent({ content }: { content: Record<string, unknown> }) {
  const c = content as VisionContentLike
  return (
    <div className="grid grid-cols-3 gap-4">
      {c.problem && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Problem
          </p>
          <p className="line-clamp-3">{c.problem}</p>
        </div>
      )}
      {c.audience && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Audience
          </p>
          <p className="line-clamp-3">{c.audience}</p>
        </div>
      )}
      {Array.isArray(c.outcomes) && c.outcomes.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-slate-400">
            Outcomes
          </p>
          <ul className="list-disc pl-4">
            {c.outcomes.slice(0, 3).map((o) => (
              <li key={o} className="line-clamp-1">
                {o}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`}
      aria-hidden="true"
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  )
}

function EyeIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M2 12s3-7 10-7 10 7 10 7-3 7-10 7-10-7-10-7Z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}
