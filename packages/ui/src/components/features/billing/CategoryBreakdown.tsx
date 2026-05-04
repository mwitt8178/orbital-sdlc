/**
 * CategoryBreakdown — pie chart + legend of spend by billing category.
 *
 * Dependency-free SVG. Mirrors the codebase's chart conventions.
 *
 * [Engineer-Principal · Opus · run-settings-billing]
 */

interface CategoryRow {
  category: string
  costUsd: number
  entryCount: number
}

interface Props {
  rows: CategoryRow[]
}

const COLORS: Record<string, string> = {
  'story-execution': '#6366f1', // indigo-500
  planning:          '#10b981', // emerald-500
  'code-review':     '#f59e0b', // amber-500
  other:             '#94a3b8', // slate-400
}

const LABELS: Record<string, string> = {
  'story-execution': 'Story execution',
  planning:          'Planning',
  'code-review':     'Code review',
  other:             'Other',
}

export function CategoryBreakdown({ rows }: Props) {
  const total = rows.reduce((acc, r) => acc + r.costUsd, 0)

  if (total <= 0) {
    return (
      <div className="flex h-40 items-center justify-center rounded-lg border border-dashed border-slate-200 text-sm text-slate-400">
        No category data yet for this period.
      </div>
    )
  }

  // Build pie slices
  const cx = 90
  const cy = 90
  const r = 80
  let cursorAngle = -Math.PI / 2 // 12 o'clock

  const slices = rows
    .filter((row) => row.costUsd > 0)
    .map((row) => {
      const frac = row.costUsd / total
      const startAngle = cursorAngle
      const endAngle = startAngle + frac * Math.PI * 2
      cursorAngle = endAngle

      const x1 = cx + r * Math.cos(startAngle)
      const y1 = cy + r * Math.sin(startAngle)
      const x2 = cx + r * Math.cos(endAngle)
      const y2 = cy + r * Math.sin(endAngle)
      const largeArc = endAngle - startAngle > Math.PI ? 1 : 0

      const path =
        frac >= 0.999
          ? `M ${cx} ${cy - r} A ${r} ${r} 0 1 1 ${cx - 0.01} ${cy - r} Z`
          : `M ${cx} ${cy} L ${x1.toFixed(2)} ${y1.toFixed(2)} A ${r} ${r} 0 ${largeArc} 1 ${x2.toFixed(2)} ${y2.toFixed(2)} Z`

      return { row, path }
    })

  return (
    <div className="grid gap-6 sm:grid-cols-[180px_minmax(0,1fr)]">
      <svg viewBox="0 0 180 180" className="h-44 w-44" role="img" aria-label="Spend by category pie chart">
        {slices.map(({ row, path }) => (
          <path
            key={row.category}
            d={path}
            fill={COLORS[row.category] ?? '#94a3b8'}
            stroke="white"
            strokeWidth="1"
          >
            <title>
              {LABELS[row.category] ?? row.category}: ${row.costUsd.toFixed(2)} ({((row.costUsd / total) * 100).toFixed(1)}%)
            </title>
          </path>
        ))}
        <circle cx={cx} cy={cy} r={36} fill="white" />
        <text x={cx} y={cy - 4} textAnchor="middle" fontSize="10" fill="#64748b">Total</text>
        <text x={cx} y={cy + 12} textAnchor="middle" fontSize="14" fontWeight="600" fill="#0f172a">
          ${total.toFixed(2)}
        </text>
      </svg>

      <ul className="space-y-2 self-center">
        {rows.map((row) => {
          const pct = total > 0 ? (row.costUsd / total) * 100 : 0
          return (
            <li key={row.category} className="flex items-center justify-between gap-4 text-sm">
              <span className="flex items-center gap-2">
                <span
                  className="inline-block h-3 w-3 rounded-sm"
                  style={{ backgroundColor: COLORS[row.category] ?? '#94a3b8' }}
                  aria-hidden="true"
                />
                <span className="font-medium text-slate-800">
                  {LABELS[row.category] ?? row.category}
                </span>
                <span className="text-xs text-slate-400">{row.entryCount} calls</span>
              </span>
              <span className="font-mono text-sm tabular-nums text-slate-900">
                ${row.costUsd.toFixed(2)}
                <span className="ml-2 text-xs text-slate-400">{pct.toFixed(0)}%</span>
              </span>
            </li>
          )
        })}
      </ul>
    </div>
  )
}
