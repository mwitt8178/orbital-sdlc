/**
 * HubTab — Settings → Hub tab.
 *
 * Round 7-02 — Local-vs-Hub Split in Local Orbital
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 *
 * Round 7-03 extension — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Round 7-05 extension — Local-only data panel
 * [Engineer-Principal · Opus · run-round7-05-local-only-isolation]
 *
 * Shows:
 *   - Current hub URL (from server config / env)
 *   - Connection status (connected / disconnected / error) + last sync time
 *   - "Test connection" button that pings the hub health endpoint
 *   - "Pair with hub" affordance: paste invite URL → join (Round 7-03)
 *   - Explanation of local-vs-hub data split
 *   - Local-only data panel: counts of replay blobs, cost-ledger entries,
 *     Anthropic key configuration — reassures the operator nothing leaked.
 */

import { useState } from 'react'
import { useHubStore } from '../../../store/hub.js'
import { JoinHubFlow } from '../onboarding/JoinHubFlow.js'
import { LocalOnlyDataPanel } from './LocalOnlyDataPanel.js'

// ---------------------------------------------------------------------------
// HubTab
// ---------------------------------------------------------------------------

/**
 * Renders the Hub configuration panel inside Settings.
 * Reads hub state from the Zustand store (populated by health poller).
 * "Test connection" makes a direct browser fetch to the hub health endpoint.
 */
export function HubTab() {
  const status = useHubStore((s) => s.status)
  const hubUrl = useHubStore((s) => s.hubUrl)
  const lastSyncAt = useHubStore((s) => s.lastSyncAt)
  const errorMessage = useHubStore((s) => s.errorMessage)
  const applyHubStatus = useHubStore((s) => s.applyHubStatus)

  const [testing, setTesting] = useState(false)
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null)
  const [showPairingFlow, setShowPairingFlow] = useState(false)

  async function handleTestConnection() {
    if (!hubUrl) return
    setTesting(true)
    setTestResult(null)
    try {
      const res = await fetch(`${hubUrl}/health`, {
        signal: AbortSignal.timeout(5_000),
      })
      if (res.ok) {
        const now = new Date().toISOString()
        applyHubStatus({ status: 'connected', hubUrl, lastSyncAt: now, errorMessage: null })
        setTestResult({ ok: true, message: 'Hub reachable — connection OK.' })
      } else {
        const msg = `HTTP ${res.status} from hub`
        applyHubStatus({ status: 'error', hubUrl, lastSyncAt, errorMessage: msg })
        setTestResult({ ok: false, message: msg })
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      applyHubStatus({ status: 'error', hubUrl, lastSyncAt, errorMessage: msg })
      setTestResult({ ok: false, message: `Connection failed: ${msg}` })
    } finally {
      setTesting(false)
    }
  }

  const statusColor: Record<string, string> = {
    connected: 'text-emerald-700 bg-emerald-50 border-emerald-200',
    connecting: 'text-amber-700 bg-amber-50 border-amber-200',
    disconnected: 'text-slate-500 bg-slate-50 border-slate-200',
    error: 'text-red-700 bg-red-50 border-red-200',
  }
  const dotColor: Record<string, string> = {
    connected: 'bg-emerald-500',
    connecting: 'bg-amber-400 animate-pulse',
    disconnected: 'bg-slate-400',
    error: 'bg-red-500',
  }
  const statusLabel: Record<string, string> = {
    connected: 'Connected',
    connecting: 'Connecting',
    disconnected: 'Not configured',
    error: 'Error',
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-900">Hub connection</h2>
        <p className="mt-1 text-sm text-slate-500">
          The hub is the central data plane shared between all operators on your team.
          Shared data (tasks, memory, channels, PRs) is stored on the hub; local-only
          data (worker processes, cost ledger, replay blobs) stays on this machine.
        </p>
      </div>

      {/* Status card */}
      <div className={`flex items-start gap-3 rounded-lg border p-4 ${statusColor[status] ?? statusColor.disconnected}`}>
        <span
          className={`mt-0.5 h-2.5 w-2.5 flex-none rounded-full ${dotColor[status] ?? dotColor.disconnected}`}
          aria-hidden="true"
        />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">
            {statusLabel[status] ?? status}
          </p>
          {hubUrl ? (
            <p className="mt-0.5 break-all text-xs opacity-75">{hubUrl}</p>
          ) : (
            <p className="mt-0.5 text-xs opacity-75">
              Set <code className="font-mono">ORBITAL_HUB_URL</code> to connect to a hub.
            </p>
          )}
          {lastSyncAt && (
            <p className="mt-1 text-xs opacity-60">
              Last sync: {new Date(lastSyncAt).toLocaleString()}
            </p>
          )}
          {errorMessage && (
            <p className="mt-1 text-xs font-medium opacity-90">{errorMessage}</p>
          )}
        </div>
      </div>

      {/* Test connection */}
      {hubUrl && (
        <div>
          <button
            type="button"
            onClick={() => void handleTestConnection()}
            disabled={testing}
            className="inline-flex items-center rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
          >
            {testing ? 'Testing...' : 'Test connection'}
          </button>

          {testResult && (
            <p
              className={`mt-2 text-sm ${testResult.ok ? 'text-emerald-700' : 'text-red-600'}`}
              role="status"
              aria-live="polite"
            >
              {testResult.message}
            </p>
          )}
        </div>
      )}

      {/* Pair with hub — Round 7-03 */}
      <section className="rounded-lg border border-slate-200 bg-white p-4">
        <header className="flex items-start justify-between">
          <div>
            <h3 className="text-sm font-semibold text-slate-900">Pair with hub</h3>
            <p className="mt-1 text-xs text-slate-500">
              Already have an invite URL from a hub owner? Paste it here to join the team.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowPairingFlow((prev) => !prev)}
            className="inline-flex items-center rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
            aria-expanded={showPairingFlow}
            aria-controls="hub-pairing-flow"
          >
            {showPairingFlow ? 'Cancel' : 'Pair with hub'}
          </button>
        </header>
        {showPairingFlow && (
          <div id="hub-pairing-flow" className="mt-4">
            <JoinHubFlow />
          </div>
        )}
      </section>

      {/* Data split explanation */}
      <section>
        <h3 className="mb-2 text-sm font-semibold text-slate-700">
          Local vs hub data
        </h3>
        <div className="grid grid-cols-2 gap-3 text-xs">
          <div className="rounded-md border border-slate-200 p-3">
            <p className="mb-1.5 font-semibold text-slate-700">Stays on this machine</p>
            <ul className="list-disc space-y-1 pl-4 text-slate-500">
              <li>Worker processes (spawned here)</li>
              <li>LLM cost ledger (this operator only)</li>
              <li>Replay blobs</li>
              <li>Local MCP gateway</li>
              <li>Anthropic API key (never sent to hub)</li>
            </ul>
          </div>
          <div className="rounded-md border border-slate-200 p-3">
            <p className="mb-1.5 font-semibold text-slate-700">Shared via hub</p>
            <ul className="list-disc space-y-1 pl-4 text-slate-500">
              <li>Tasks + sprint board</li>
              <li>Project memory</li>
              <li>Channels + messages</li>
              <li>Defects + audit events</li>
              <li>PR linkage state</li>
            </ul>
          </div>
        </div>
      </section>

      {/* Round 7-05 — Local-only data inventory */}
      <LocalOnlyDataPanel />
    </div>
  )
}
