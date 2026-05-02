/**
 * ToolCallTimeline — vertical timeline of tool + LLM calls in chronological order.
 *
 * Per drawer content spec from architecture.md:
 *   - Each entry: icon (tool kind / LLM), name, args summary, result status, duration
 *   - LLM calls show in/out token counts and cost
 *   - Tool calls show outcome (ok/err) and 1-line excerpt
 *   - Click any entry → expands to full args/result
 *
 * [Engineer-Sr · Sonnet · run-round6-10-inspection]
 */

import { useState } from 'react'
import clsx from 'clsx'
import type { WorkerInspection } from './types.js'

type TimelineEntry =
  | ({ kind: 'tool' } & WorkerInspection['recentToolCalls'][number])
  | ({ kind: 'llm' } & WorkerInspection['recentLLMCalls'][number])

interface ToolCallTimelineProps {
  inspection: WorkerInspection
}

function StatusBadge({ status }: { status: 'pending' | 'ok' | 'err' }) {
  return (
    <span
      className={clsx(
        'rounded-full px-1.5 py-0.5 text-[10px] font-medium',
        status === 'ok' && 'bg-emerald-100 text-emerald-700',
        status === 'err' && 'bg-red-100 text-red-700',
        status === 'pending' && 'bg-amber-100 text-amber-700',
      )}
    >
      {status}
    </span>
  )
}

function ToolEntryRow({ entry }: { entry: { kind: 'tool' } & WorkerInspection['recentToolCalls'][number] }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      className="w-full rounded-md border border-slate-100 bg-white px-3 py-2 text-left transition hover:border-slate-200 hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <div className="flex items-center gap-2">
        {/* Tool icon */}
        <span className="flex-shrink-0 text-slate-400" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
          </svg>
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-slate-700">{entry.name}</span>
        <StatusBadge status={entry.status} />
        {entry.durationMs !== undefined && (
          <span className="flex-shrink-0 font-mono text-[10px] text-slate-400">{entry.durationMs}ms</span>
        )}
      </div>
      {entry.argsSummary && (
        <div className="mt-1 truncate pl-5 font-mono text-[10px] text-slate-500">{entry.argsSummary}</div>
      )}
      {expanded && entry.resultExcerpt && (
        <div className="mt-1.5 rounded bg-slate-50 p-1.5 pl-5 font-mono text-[10px] text-slate-600">
          {entry.resultExcerpt}
        </div>
      )}
    </button>
  )
}

function LLMEntryRow({ entry }: { entry: { kind: 'llm' } & WorkerInspection['recentLLMCalls'][number] }) {
  const [expanded, setExpanded] = useState(false)

  return (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      className="w-full rounded-md border border-blue-100 bg-blue-50/50 px-3 py-2 text-left transition hover:border-blue-200 hover:bg-blue-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500"
    >
      <div className="flex items-center gap-2">
        {/* LLM icon */}
        <span className="flex-shrink-0 text-blue-400" aria-hidden="true">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
          </svg>
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-blue-700">{entry.model}</span>
        <StatusBadge status={entry.status} />
        {entry.durationMs !== undefined && (
          <span className="flex-shrink-0 font-mono text-[10px] text-slate-400">{entry.durationMs}ms</span>
        )}
      </div>
      {expanded && (
        <div className="mt-1.5 space-y-0.5 pl-5 text-[10px] text-slate-600">
          {entry.inputTokens !== undefined && (
            <div>In: <span className="font-mono">{entry.inputTokens}</span> tokens</div>
          )}
          {entry.outputTokens !== undefined && (
            <div>Out: <span className="font-mono">{entry.outputTokens}</span> tokens</div>
          )}
          {entry.costUSD !== undefined && (
            <div>Cost: <span className="font-mono">${entry.costUSD.toFixed(4)}</span></div>
          )}
        </div>
      )}
    </button>
  )
}

export function ToolCallTimeline({ inspection }: ToolCallTimelineProps) {
  // Merge and sort tool calls + LLM calls by startedAt
  const entries: TimelineEntry[] = [
    ...inspection.recentToolCalls.map((tc) => ({ kind: 'tool' as const, ...tc })),
    ...inspection.recentLLMCalls.map((lc) => ({ kind: 'llm' as const, ...lc })),
  ].sort((a, b) => {
    const aTime = a.startedAt
    const bTime = b.startedAt
    return aTime < bTime ? -1 : aTime > bTime ? 1 : 0
  })

  if (entries.length === 0) {
    return (
      <div className="py-4 text-center text-xs text-slate-400">
        No tool or LLM calls recorded yet
      </div>
    )
  }

  return (
    <div className="space-y-1.5">
      {entries.map((entry, i) => (
        <div key={entry.kind === 'tool' ? entry.toolCallId : entry.llmCallId + String(i)}>
          {entry.kind === 'tool' ? (
            <ToolEntryRow entry={entry} />
          ) : (
            <LLMEntryRow entry={entry} />
          )}
        </div>
      ))}
    </div>
  )
}
