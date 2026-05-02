/**
 * RoutingPolicyTab — read-only summary of the model-routing policy.
 *
 * v1: surfaces the canonical default policy keyed by risk class. The actual
 * runtime values live in config/routing-policy.default.ts; we mirror them
 * here so users can see what is in effect without leaving the UI.
 */

interface RouteEntry {
  riskClass: 'low' | 'standard' | 'high' | 'critical'
  preferred: string
  fallback: string | null
  rationale: string
}

const DEFAULT_POLICY: RouteEntry[] = [
  {
    riskClass: 'low',
    preferred: 'claude-haiku-4-5',
    fallback: 'claude-sonnet-4-6',
    rationale: 'Cheap, deterministic work — formatting, summaries.',
  },
  {
    riskClass: 'standard',
    preferred: 'claude-sonnet-4-6',
    fallback: 'claude-opus-4-6',
    rationale: 'Default for most engineering work.',
  },
  {
    riskClass: 'high',
    preferred: 'claude-opus-4-6',
    fallback: null,
    rationale: 'Architectural change, security-adjacent code.',
  },
  {
    riskClass: 'critical',
    preferred: 'claude-opus-4-6',
    fallback: null,
    rationale: 'IAM changes, billing, compliance — Engineer-Principal tier.',
  },
]

export function RoutingPolicyTab() {
  return (
    <div className="space-y-3">
      <p className="text-xs text-slate-500">
        Edit via config files in
        <code className="mx-1 rounded bg-slate-100 px-1 py-0.5 font-mono text-[11px] text-slate-700">
          config/routing-policy.default.ts
        </code>
        — UI editing is a v2 feature.
      </p>
      <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
        <table className="w-full table-fixed">
          <thead>
            <tr className="border-b border-slate-100 bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
              <th className="px-4 py-2 text-left font-medium">Risk class</th>
              <th className="px-4 py-2 text-left font-medium">Preferred model</th>
              <th className="px-4 py-2 text-left font-medium">Fallback</th>
              <th className="px-4 py-2 text-left font-medium">Rationale</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100 text-sm text-slate-700">
            {DEFAULT_POLICY.map((row) => (
              <tr key={row.riskClass}>
                <td className="px-4 py-2 font-medium text-slate-900">{row.riskClass}</td>
                <td className="px-4 py-2 font-mono text-xs text-slate-700">{row.preferred}</td>
                <td className="px-4 py-2 font-mono text-xs text-slate-500">
                  {row.fallback ?? '—'}
                </td>
                <td className="px-4 py-2 text-xs text-slate-500">{row.rationale}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
