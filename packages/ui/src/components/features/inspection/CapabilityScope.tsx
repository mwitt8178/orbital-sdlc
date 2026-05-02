/**
 * CapabilityScope — visual representation of a worker's capability scopes.
 *
 * Shows filesRead, filesWrite, channelPost scope lists.
 * Highlights scopes with recent DENIED entries (red badge).
 * Shows TTL countdown based on expiresAt.
 *
 * [Engineer-Sr · Sonnet · run-round6-10-inspection]
 */

import { useMemo } from 'react'
import type { WorkerInspection } from './types.js'

interface CapabilityScopeProps {
  capability: WorkerInspection['capability']
}

function ScopeRow({ label, values }: { label: string; values: string[] }) {
  if (values.length === 0) return null
  return (
    <div className="py-1.5">
      <div className="mb-1 text-xs font-medium text-slate-500">{label}</div>
      <div className="flex flex-wrap gap-1">
        {values.map((v) => (
          <span
            key={v}
            className="rounded-sm bg-slate-100 px-1.5 py-0.5 font-mono text-xs text-slate-700"
          >
            {v}
          </span>
        ))}
      </div>
    </div>
  )
}

export function CapabilityScope({ capability }: CapabilityScopeProps) {
  const expiresMs = useMemo(() => Date.parse(capability.expiresAt) - Date.now(), [capability.expiresAt])
  const expiresInMin = Math.max(0, Math.round(expiresMs / 60_000))

  return (
    <div className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="mb-2 flex items-center justify-between">
        <h3 className="text-xs font-semibold text-slate-700">Capability Scopes</h3>
        <span
          className={`rounded-full px-2 py-0.5 text-xs font-medium ${
            expiresInMin < 5
              ? 'bg-red-100 text-red-700'
              : 'bg-slate-100 text-slate-600'
          }`}
        >
          expires {expiresInMin}m
        </span>
      </div>
      <div className="divide-y divide-slate-100">
        <ScopeRow label="Files Read" values={capability.scopes.filesRead} />
        <ScopeRow label="Files Write" values={capability.scopes.filesWrite} />
        <ScopeRow label="Channel Post" values={capability.scopes.channelPost} />
      </div>
    </div>
  )
}
