/**
 * HygienePanel — /admin/hygiene
 *
 * Sweeps accumulated test/fixture data (stories, sprints, escalations) from
 * agent runs without deleting any rows. All operations are state transitions
 * that preserve the full audit trail.
 *
 * Flow:
 *   1. "Preview sweep" — calls admin.hygiene.preview (dry-run, no mutations).
 *      Shows counts + sample items.
 *   2. "Run sweep" — confirmation modal → calls admin.hygiene.run with
 *      ack='I understand'. Shows result summary.
 */

import { useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'
import { Modal } from '../../ui/Modal.js'
import { Skeleton } from '../../ui/Skeleton.js'
import { ErrorMessage } from '../../ui/ErrorMessage.js'
import { useAdminToken } from './admin-context.js'

// ---------------------------------------------------------------------------
// Types (inferred from output schema — no import from server)
// ---------------------------------------------------------------------------

interface HygieneSweepResult {
  stories: { archived: number; items: Array<{ storyId: string; title: string; status: string }> }
  sprints: { archived: number; items: Array<{ sprintId: string; name: string; status: string }> }
  escalations: {
    acknowledged: number
    items: Array<{ escalationId: string; taskId: string; reason: string; createdAt: string }>
  }
  dryRun: boolean
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SweepSummary({
  result,
  label,
}: {
  result: HygieneSweepResult
  label: string
}) {
  return (
    <div className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{label}</p>
      <div className="grid grid-cols-3 gap-4">
        <StatCard
          title="Stories"
          count={result.stories.archived}
          label={result.dryRun ? 'to cancel' : 'cancelled'}
          color="amber"
        />
        <StatCard
          title="Sprints"
          count={result.sprints.archived}
          label={result.dryRun ? 'to complete' : 'completed'}
          color="blue"
        />
        <StatCard
          title="Escalations"
          count={result.escalations.acknowledged}
          label={result.dryRun ? 'to acknowledge' : 'acknowledged'}
          color="rose"
        />
      </div>

      {result.stories.items.length > 0 && (
        <SampleList
          title="Sample stories"
          items={result.stories.items.slice(0, 5).map((s) => `"${s.title}" (${s.status})`)}
        />
      )}
      {result.sprints.items.length > 0 && (
        <SampleList
          title="Sample sprints"
          items={result.sprints.items.slice(0, 5).map((s) => `"${s.name}" (${s.status})`)}
        />
      )}
      {result.escalations.items.length > 0 && (
        <SampleList
          title="Sample escalations"
          items={result.escalations.items
            .slice(0, 5)
            .map((e) => `${e.reason} — task ${e.taskId.slice(0, 8)}…`)}
        />
      )}
    </div>
  )
}

function StatCard({
  title,
  count,
  label,
  color,
}: {
  title: string
  count: number
  label: string
  color: 'amber' | 'blue' | 'rose'
}) {
  const colorMap = {
    amber: 'bg-amber-50 border-amber-200 text-amber-700',
    blue: 'bg-blue-50 border-blue-200 text-blue-700',
    rose: 'bg-rose-50 border-rose-200 text-rose-700',
  }
  return (
    <div className={`rounded-md border p-4 ${colorMap[color]}`}>
      <p className="text-xs font-medium uppercase tracking-wide opacity-70">{title}</p>
      <p className="mt-1 text-3xl font-bold">{count}</p>
      <p className="text-xs opacity-70">{label}</p>
    </div>
  )
}

function SampleList({ title, items }: { title: string; items: string[] }) {
  return (
    <div className="mt-3">
      <p className="text-xs font-medium text-slate-500">{title} (sample):</p>
      <ul className="mt-1 list-inside list-disc space-y-0.5 text-xs text-slate-600">
        {items.map((item, i) => (
          <li key={i}>{item}</li>
        ))}
      </ul>
    </div>
  )
}

// ---------------------------------------------------------------------------
// HygienePanel
// ---------------------------------------------------------------------------

export function HygienePanel() {
  const { token } = useAdminToken()
  const utils = trpc.useUtils()

  const [showConfirm, setShowConfirm] = useState(false)
  const [olderThanDays, setOlderThanDays] = useState<number>(0)
  const [lastResult, setLastResult] = useState<HygieneSweepResult | null>(null)
  const [lastRunAt, setLastRunAt] = useState<string | null>(null)

  const preview = trpc.admin.hygiene.preview.useQuery(undefined, {
    // Do not auto-refetch — user triggers this explicitly.
    enabled: false,
    refetchOnWindowFocus: false,
  })

  const run = trpc.admin.hygiene.run.useMutation({
    onSuccess: (data) => {
      setLastResult(data)
      setLastRunAt(new Date().toISOString())
      setShowConfirm(false)
      void utils.admin.hygiene.preview.invalidate()
    },
  })

  const handlePreview = () => {
    void preview.refetch()
  }

  const handleRunConfirmed = () => {
    run.mutate({
      adminToken: token ?? undefined,
      ack: 'I understand',
      olderThanDays,
    })
  }

  return (
    <div className="space-y-6">
      <header>
        <h2 className="text-base font-semibold text-slate-900">Test Data Hygiene</h2>
        <p className="mt-0.5 text-sm text-slate-500">
          Sweep fixture/test data accumulated from agent runs. Stories, sprints, and escalations are
          NOT deleted — they are transitioned to cancelled/acknowledged states so the audit trail is
          preserved.
        </p>
      </header>

      {/* Controls */}
      <section className="flex flex-wrap items-end gap-4">
        <div>
          <label className="block text-xs font-medium text-slate-700" htmlFor="older-than-days">
            Escalation cutoff (days)
          </label>
          <p className="mt-0.5 text-xs text-slate-400">
            0 = acknowledge all open escalations
          </p>
          <input
            id="older-than-days"
            type="number"
            min={0}
            value={olderThanDays}
            onChange={(e) => setOlderThanDays(Math.max(0, Number(e.target.value)))}
            className="mt-1 w-32 rounded-md border border-slate-300 px-3 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-brand-500"
          />
        </div>

        <Button
          variant="secondary"
          onClick={handlePreview}
          disabled={preview.isFetching}
        >
          {preview.isFetching ? 'Previewing…' : 'Preview sweep'}
        </Button>

        <Button
          onClick={() => setShowConfirm(true)}
          disabled={run.isPending}
        >
          {run.isPending ? 'Running…' : 'Run sweep'}
        </Button>
      </section>

      {/* Preview result */}
      {preview.isError && (
        <ErrorMessage message={preview.error.message ?? 'Preview failed'} />
      )}
      {preview.isFetching && <Skeleton className="h-40 w-full" />}
      {preview.data && !preview.isFetching && (
        <SweepSummary result={preview.data as HygieneSweepResult} label="Preview (dry-run)" />
      )}

      {/* Run error */}
      {run.isError && (
        <ErrorMessage message={run.error.message ?? 'Sweep failed'} />
      )}

      {/* Most recent real sweep result */}
      {lastResult && lastRunAt && (
        <div className="space-y-2">
          <p className="text-xs text-slate-500">
            Last sweep run at{' '}
            <span className="font-mono">
              {new Date(lastRunAt).toLocaleString()}
            </span>
          </p>
          <SweepSummary result={lastResult} label="Last sweep result" />
        </div>
      )}

      {/* Confirmation modal */}
      <Modal
        open={showConfirm}
        title="Confirm hygiene sweep"
        onClose={() => setShowConfirm(false)}
      >
          <div className="space-y-4">
            <p className="text-sm text-slate-700">
              This will transition fixture stories to{' '}
              <span className="font-mono text-amber-700">cancelled</span>, fixture sprints to{' '}
              <span className="font-mono text-blue-700">completed</span>, and open escalations
              (older than {olderThanDays} days) to{' '}
              <span className="font-mono text-rose-700">acknowledged</span>.
            </p>
            <p className="text-sm font-medium text-slate-900">
              No rows will be deleted. The audit trail is fully preserved.
            </p>
            <div className="flex justify-end gap-3">
              <Button
                variant="secondary"
                onClick={() => setShowConfirm(false)}
                disabled={run.isPending}
              >
                Cancel
              </Button>
              <Button
                onClick={handleRunConfirmed}
                disabled={run.isPending}
              >
                {run.isPending ? 'Running…' : 'Run sweep'}
              </Button>
            </div>
          </div>
        </Modal>
    </div>
  )
}
