/**
 * Vision page — split layout: PM intake chat (left), vision document (right).
 *
 * The version-history panel renders below the document, scoped to the
 * currently-active vision document.
 */

import { Link, useLocation } from 'react-router-dom'
import { VisionChat } from '../components/features/vision/VisionChat.js'
import { VisionDocumentDisplay } from '../components/features/vision/VisionDocumentDisplay.js'
import { VisionHistoryPanel } from '../components/features/vision/VisionHistoryPanel.js'
import { PlanningPanel } from '../components/features/vision/PlanningPanel.js'
import { useVisionStore } from '../store/vision.js'
import { trpc } from '../services/trpc.js'
import { ProjectBreadcrumb } from '../components/layout/ProjectBreadcrumb.js'

export default function Vision() {
  const documentId = useVisionStore((s) => s.currentDocumentId)
  const location = useLocation()
  const planningDocQuery = trpc.vision.get.useQuery(
    documentId ? { vision_document_id: documentId } : (undefined as never),
    { enabled: !!documentId, staleTime: 5_000 },
  )
  const isLocked = !!planningDocQuery.data?.version?.is_locked
  const fromSettings = (location.state as { from?: string } | null)?.from === '/settings'

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-6">
      <header className="mb-6">
        <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
          <ProjectBreadcrumb />
          <span aria-hidden="true">›</span>
          <Link
            to="/backlog"
            className="hover:text-slate-700 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            Backlog
          </Link>
          <span aria-hidden="true">›</span>
          <span>Vision</span>
        </div>
        <h1 className="text-2xl font-bold text-slate-900">Vision</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-600">
          Your project&apos;s north star — <strong>what you&apos;re building and why</strong>.
          Every epic, story, sprint, and AC traces back to it. The PM persona
          interviews you to write a tight vision document; lock it once you&apos;re
          confident in the direction.
        </p>
        <details className="mt-2 text-xs text-slate-500">
          <summary className="cursor-pointer hover:text-slate-700">
            How visions work
          </summary>
          <ul className="mt-2 ml-4 list-disc space-y-1">
            <li>
              <strong>One vision per project.</strong> You don&apos;t need a new
              one for each sprint — sprints decompose the existing vision.
            </li>
            <li>
              <strong>Revise, don&apos;t recreate.</strong> When the product
              direction shifts, click &ldquo;Revise&rdquo; on the locked
              version. The prior version is preserved in history.
            </li>
            <li>
              <strong>New project = new vision.</strong> If you&apos;re working
              on a different product, switch the project from the top bar.
            </li>
          </ul>
        </details>

        {(fromSettings || documentId) && (
          <div className="mt-3 flex items-start gap-2 rounded-md border border-blue-100 bg-blue-50 px-3 py-2.5 text-xs text-blue-700">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="mt-0.5 flex-shrink-0"
              aria-hidden="true"
            >
              <circle cx="12" cy="12" r="10" />
              <path d="M12 16v-4" />
              <path d="M12 8h.01" />
            </svg>
            <span>
              Most projects have one vision. If you&apos;ve been redirected here from /settings,
              use the <strong>Revise</strong> flow on the existing locked version.
            </span>
          </div>
        )}
      </header>

      <div className="grid grid-cols-2 gap-5">
        <VisionChat />
        <VisionDocumentDisplay />
      </div>

      <div className="mt-5">
        <PlanningPanel visionId={documentId ?? ''} isLocked={isLocked && !!documentId} />
      </div>

      {documentId && (
        <div className="mt-5">
          <VisionHistoryPanel />
        </div>
      )}
    </div>
  )
}
