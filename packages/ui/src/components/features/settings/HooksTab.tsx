/**
 * HooksTab — read-only list of registered hooks.
 *
 * Mirrors packages/orchestrator/src/hooks/baseline/. There is no tRPC
 * procedure that lists hooks at runtime, so the canonical names + version +
 * status are surfaced here. v2 will introduce a hook-registry procedure.
 */

import { Badge } from '../../ui/Badge.js'

interface HookEntry {
  slug: string
  description: string
  appliesTo: string
  timing: 'pre' | 'post'
  version: string
  status: 'active' | 'disabled'
}

const BASELINE_HOOKS: HookEntry[] = [
  {
    slug: 'commit-must-have-ticket-ref',
    description:
      'Every commit must reference its ticket id and stay within the declared files_write scope.',
    appliesTo: 'AgentCommitted',
    timing: 'pre',
    version: '1.0.0',
    status: 'active',
  },
  {
    slug: 'pre-merge-acceptance-evidence',
    description: 'Verifies acceptance evidence is attached before merging.',
    appliesTo: 'AgentMergeRequested',
    timing: 'pre',
    version: '1.0.0',
    status: 'active',
  },
  {
    slug: 'pre-status-transition-evidence',
    description: 'Blocks status transitions without the required evidence column writes.',
    appliesTo: 'TaskStatusTransitionRequested',
    timing: 'pre',
    version: '1.0.0',
    status: 'active',
  },
  {
    slug: 'post-task-trigger-verifier',
    description: 'On TaskCompleted with ready_for_verification=true, spawns the verifier persona.',
    appliesTo: 'TaskCompleted',
    timing: 'post',
    version: '1.0.0',
    status: 'active',
  },
]

export function HooksTab() {
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Hooks gate state transitions. Edit via files in
        <code className="mx-1 rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-700">
          packages/orchestrator/src/hooks/baseline/
        </code>
        — UI editing is a v2 feature.
      </p>
      <ul className="divide-y divide-slate-100 rounded-lg border border-slate-200 bg-white">
        {BASELINE_HOOKS.map((h) => (
          <li key={h.slug} className="px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <p className="text-sm font-semibold text-slate-900">{h.slug}</p>
                  <Badge color={h.timing === 'pre' ? 'amber' : 'emerald'}>{h.timing}</Badge>
                  <Badge color={h.status === 'active' ? 'emerald' : 'slate'}>{h.status}</Badge>
                </div>
                <p className="mt-1 text-xs text-slate-500">{h.description}</p>
                <p className="mt-1 font-mono text-[11px] text-slate-400">
                  Applies to: <span className="text-slate-600">{h.appliesTo}</span>
                </p>
              </div>
              <span className="flex-shrink-0 font-mono text-[11px] text-slate-400">
                v{h.version}
              </span>
            </div>
          </li>
        ))}
      </ul>
    </div>
  )
}
