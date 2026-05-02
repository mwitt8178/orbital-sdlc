/**
 * Audit page — event timeline + export request flow.
 *
 * When the URL carries `?export=true` (the dashboard "Export audit"
 * shortcut), we click the Export button programmatically once the form
 * is mounted so the modal opens automatically. We don't reach into the
 * ExportRequestForm internals because that file is owned by another
 * agent — the click is dispatched against its accessible label.
 */

import { useEffect, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { EventTimeline } from '../components/features/audit/EventTimeline.js'
import { ExportRequestForm } from '../components/features/audit/ExportRequestForm.js'
import { ExportProgressList } from '../components/features/audit/ExportProgressList.js'
// Round 6 #7 — Determinism / Replay
// [Engineer-Principal · Opus · run-round6-07-replay]
import { ReplayDrawer } from '../components/features/audit/ReplayDrawer.js'

export default function Audit() {
  const [_lastRequestedExportId, setLastRequestedExportId] = useState<string | null>(null)
  // Round 6 #7 — capture id whose replay drawer is currently open.
  const [replayCaptureId, setReplayCaptureId] = useState<string | null>(null)
  const location = useLocation()
  const navigate = useNavigate()

  useEffect(() => {
    const params = new URLSearchParams(location.search)
    if (params.get('export') !== 'true') return
    // Defer to next frame so the ExportRequestForm has mounted its button.
    const id = window.requestAnimationFrame(() => {
      const btn = document.querySelector<HTMLButtonElement>(
        'button[aria-label="Request audit export"]',
      )
      btn?.click()
    })
    // Strip the query so a refresh doesn't keep re-opening the modal.
    navigate(location.pathname, { replace: true })
    return () => window.cancelAnimationFrame(id)
    // navigate/location are stable; we only want this on mount + when search
    // changes, which is correctly captured by location.search.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.search])

  return (
    <div className="mx-auto max-w-[1400px] px-8 py-6">
      <header className="mb-6 flex items-start justify-between">
        <div>
          <div className="mb-1 flex items-center gap-2 text-xs text-slate-500">
            <span>Acme Product</span>
            <span aria-hidden="true">›</span>
            <span>Audit Log</span>
          </div>
          <h1 className="text-2xl font-bold text-slate-900">Audit Log</h1>
          <p className="mt-1 text-sm text-slate-500">
            Immutable event log. Every state change from every agent, hook, and capability grant
            is recorded here.
          </p>
        </div>
        <ExportRequestForm onRequested={setLastRequestedExportId} />
      </header>

      <section className="mb-6">
        <header className="mb-3 flex items-center justify-between">
          <h2 className="text-sm font-semibold text-slate-900">Recent exports</h2>
        </header>
        <ExportProgressList />
      </section>

      <EventTimeline onOpenReplay={(captureId) => setReplayCaptureId(captureId)} />

      {/* Round 6 #7 — Determinism / Replay drawer */}
      <ReplayDrawer captureId={replayCaptureId} onClose={() => setReplayCaptureId(null)} />
    </div>
  )
}
