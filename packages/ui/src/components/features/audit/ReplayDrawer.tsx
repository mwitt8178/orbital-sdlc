/**
 * ReplayDrawer — right-side drawer that displays a replay capture in full.
 *
 * [Engineer-Principal · Opus · run-round6-07-replay]
 *
 * Tabs:
 *   - Request   — pretty-printed (canonical) JSON of the captured request
 *   - Response  — pretty-printed (canonical) JSON of the captured response
 *   - Replay    — buttons: Inspect / Replay (substituted) / Replay (live)
 *   - Diff      — side-by-side comparison after a replay run
 *
 * Footer: storage_uri, request hash, response hash, blob size — operator
 * uses these to verify integrity against the audit chain.
 */

import { useEffect, useMemo, useState } from 'react'
import { trpc } from '../../../services/trpc.js'
import { ReplayDiff } from './ReplayDiff.js'

interface ReplayDrawerProps {
  /** capture_id of the replay capture to render. Null closes the drawer. */
  captureId: string | null
  onClose: () => void
}

type Tab = 'request' | 'response' | 'replay' | 'diff'

interface ReplayResponseShape {
  recorded_request?: unknown
  recorded_response?: unknown
  replay_response?: unknown
  matched_hash?: boolean
  duration_ms?: number
  played_at?: string
  mode?: string
}

function canonicalJSON(v: unknown, indent = 2): string {
  return JSON.stringify(v, (_k, val) => {
    if (val === null || typeof val !== 'object' || Array.isArray(val)) return val
    const o = val as Record<string, unknown>
    return Object.keys(o)
      .sort()
      .reduce<Record<string, unknown>>((acc, k) => {
        acc[k] = o[k]
        return acc
      }, {})
  }, indent)
}

export function ReplayDrawer({ captureId, onClose }: ReplayDrawerProps) {
  const [tab, setTab] = useState<Tab>('request')
  const [replayResult, setReplayResult] = useState<ReplayResponseShape | null>(null)
  const [replayBusy, setReplayBusy] = useState(false)
  const [replayErr, setReplayErr] = useState<string | null>(null)

  const captureQ = (trpc as unknown as {
    replay: {
      get: { useQuery: (input: { capture_id: string }, opts: { enabled: boolean }) => {
        data?: {
          capture_id: string
          worker_id: string | null
          task_id: string | null
          event_id: string | null
          capture_kind: string
          provider: string | null
          model: string | null
          request_hash: string
          response_hash: string
          storage_uri: string
          size_bytes: number
          occurred_at: string
        }
        isLoading: boolean
        error: { message: string } | null
      } }
    }
  }).replay.get.useQuery({ capture_id: captureId ?? '' }, { enabled: !!captureId })

  const replayMutation = (trpc as unknown as {
    replay: {
      replay: {
        useMutation: () => {
          mutateAsync: (input: { capture_id: string; mode: 'inspect' | 'replay-substituted' | 'replay-live' }) => Promise<ReplayResponseShape>
          isPending: boolean
        }
      }
    }
  }).replay.replay.useMutation()

  // Reset when the capture id changes.
  useEffect(() => {
    setTab('request')
    setReplayResult(null)
    setReplayErr(null)
  }, [captureId])

  const handleReplay = async (mode: 'inspect' | 'replay-substituted' | 'replay-live'): Promise<void> => {
    if (!captureId) return
    setReplayBusy(true)
    setReplayErr(null)
    try {
      const result = await replayMutation.mutateAsync({ capture_id: captureId, mode })
      setReplayResult(result)
      setTab('diff')
    } catch (e) {
      setReplayErr(e instanceof Error ? e.message : String(e))
    } finally {
      setReplayBusy(false)
    }
  }

  const requestJson = useMemo(
    () => canonicalJSON(replayResult?.recorded_request ?? {}),
    [replayResult],
  )
  const responseJson = useMemo(
    () => canonicalJSON(replayResult?.recorded_response ?? {}),
    [replayResult],
  )

  if (!captureId) return null

  return (
    <div
      role="dialog"
      aria-label="Replay capture detail"
      data-testid="replay-drawer"
      className="fixed inset-y-0 right-0 z-40 flex w-[640px] max-w-full flex-col border-l border-slate-200 bg-white shadow-xl"
    >
      <header className="flex items-center justify-between border-b border-slate-200 px-5 py-3">
        <div className="min-w-0">
          <div className="text-sm font-semibold text-slate-900">Replay capture</div>
          <div className="truncate font-mono text-xs text-slate-500">{captureId}</div>
        </div>
        <button
          type="button"
          aria-label="Close replay drawer"
          onClick={onClose}
          className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-600"
        >
          ×
        </button>
      </header>

      {captureQ.isLoading ? (
        <div className="px-5 py-4 text-sm text-slate-500">Loading capture…</div>
      ) : captureQ.error ? (
        <div className="px-5 py-4 text-sm text-rose-600">{captureQ.error.message}</div>
      ) : !captureQ.data ? (
        <div className="px-5 py-4 text-sm text-slate-500">Capture not found.</div>
      ) : (
        <>
          <nav className="flex gap-1 border-b border-slate-200 px-3 py-2">
            {(['request', 'response', 'replay', 'diff'] as const).map((t) => (
              <button
                key={t}
                type="button"
                onClick={() => setTab(t)}
                className={`rounded px-3 py-1 text-xs font-medium ${
                  tab === t
                    ? 'bg-brand-100 text-brand-700'
                    : 'text-slate-600 hover:bg-slate-100'
                }`}
              >
                {t === 'request' ? 'Request' : t === 'response' ? 'Response' : t === 'replay' ? 'Replay' : 'Diff'}
              </button>
            ))}
          </nav>

          <main className="flex-1 overflow-auto px-5 py-4">
            {tab === 'request' && (
              <div>
                <div className="mb-1 text-xs font-medium text-slate-600">
                  Captured request {replayResult ? '(live)' : '(load via Replay tab)'}
                </div>
                <pre className="max-h-[60vh] overflow-auto rounded border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-700">
                  {replayResult ? requestJson : '(switch to the Replay tab to inspect)'}
                </pre>
              </div>
            )}
            {tab === 'response' && (
              <div>
                <div className="mb-1 text-xs font-medium text-slate-600">
                  Captured response {replayResult ? '(live)' : '(load via Replay tab)'}
                </div>
                <pre className="max-h-[60vh] overflow-auto rounded border border-slate-200 bg-slate-50 p-3 font-mono text-xs text-slate-700">
                  {replayResult ? responseJson : '(switch to the Replay tab to inspect)'}
                </pre>
              </div>
            )}
            {tab === 'replay' && (
              <div className="space-y-3">
                <p className="text-sm text-slate-600">
                  Choose a replay mode. Inspect renders without re-running.
                  Substituted feeds the recorded response back. Live re-calls
                  the original LLM/tool.
                </p>
                <div className="flex flex-wrap gap-2">
                  <button
                    type="button"
                    onClick={() => void handleReplay('inspect')}
                    disabled={replayBusy}
                    className="rounded bg-slate-100 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-200 disabled:opacity-50"
                  >
                    Inspect
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleReplay('replay-substituted')}
                    disabled={replayBusy}
                    className="rounded bg-brand-100 px-3 py-1.5 text-sm font-medium text-brand-700 hover:bg-brand-200 disabled:opacity-50"
                  >
                    Replay (substituted)
                  </button>
                  <button
                    type="button"
                    onClick={() => void handleReplay('replay-live')}
                    disabled={replayBusy}
                    className="rounded bg-amber-100 px-3 py-1.5 text-sm font-medium text-amber-700 hover:bg-amber-200 disabled:opacity-50"
                  >
                    Replay (live)
                  </button>
                </div>
                {replayBusy && <div className="text-xs text-slate-500">Replaying…</div>}
                {replayErr && <div className="text-xs text-rose-600">{replayErr}</div>}
                {replayResult && (
                  <div className="rounded border border-slate-200 bg-slate-50 p-3 text-xs">
                    Mode: <span className="font-medium">{replayResult.mode}</span>
                    {' · '}
                    Duration: {replayResult.duration_ms}ms
                    {' · '}
                    Match: {replayResult.matched_hash ? 'yes' : 'no'}
                  </div>
                )}
              </div>
            )}
            {tab === 'diff' && (
              <ReplayDiff
                recorded={(replayResult?.recorded_response ?? null) as Record<string, unknown> | null}
                replay={(replayResult?.replay_response ?? null) as Record<string, unknown> | null}
                matchedHash={Boolean(replayResult?.matched_hash)}
              />
            )}
          </main>

          <footer className="border-t border-slate-200 bg-slate-50 px-5 py-2 text-xs text-slate-600">
            <div className="grid grid-cols-2 gap-1">
              <div>
                <span className="text-slate-400">Provider</span>{' '}
                {captureQ.data.provider ?? 'tool'}
              </div>
              <div>
                <span className="text-slate-400">Model</span>{' '}
                {captureQ.data.model ?? '-'}
              </div>
              <div className="col-span-2">
                <span className="text-slate-400">Storage</span>{' '}
                <span className="break-all font-mono">{captureQ.data.storage_uri}</span>
              </div>
              <div>
                <span className="text-slate-400">req sha256</span>{' '}
                <span className="font-mono">{captureQ.data.request_hash.slice(0, 12)}…</span>
              </div>
              <div>
                <span className="text-slate-400">resp sha256</span>{' '}
                <span className="font-mono">{captureQ.data.response_hash.slice(0, 12)}…</span>
              </div>
              <div className="col-span-2">
                <span className="text-slate-400">size</span>{' '}
                {captureQ.data.size_bytes} bytes
              </div>
            </div>
          </footer>
        </>
      )}
    </div>
  )
}
