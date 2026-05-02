/**
 * LiveBurnChart — stacked area chart of cost burn over time.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 *
 * Uses SVG path math for a dependency-free area chart.
 * X axis: time (window), Y axis: cumulative cost USD.
 */

interface BurnPoint {
  ts: number
  costUsd: number
}

interface LiveBurnChartProps {
  points: BurnPoint[]
  hardCapUsd: number | null
  /** Chart label: '1h' | '24h' | '7d' */
  label?: string
  height?: number
}

function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v))
}

export function LiveBurnChart({ points, hardCapUsd, label = '24h', height = 120 }: LiveBurnChartProps) {
  const W = 520
  const H = height
  const PAD = { top: 12, right: 16, bottom: 24, left: 44 }
  const chartW = W - PAD.left - PAD.right
  const chartH = H - PAD.top  - PAD.bottom

  const hasData = points.length >= 2

  const maxCost = hasData
    ? Math.max(...points.map((p) => p.costUsd), hardCapUsd ?? 0, 0.001)
    : (hardCapUsd ?? 1)

  const minTs = hasData ? points[0]!.ts : 0
  const maxTs = hasData ? points[points.length - 1]!.ts : 1

  const xScale = (ts: number) =>
    PAD.left + ((ts - minTs) / (maxTs - minTs || 1)) * chartW

  const yScale = (v: number) =>
    PAD.top + chartH - (v / maxCost) * chartH

  // Build SVG path for the area
  let areaPath = ''
  if (hasData) {
    const pts = points.map((p) => `${xScale(p.ts).toFixed(1)},${yScale(p.costUsd).toFixed(1)}`)
    const firstX = xScale(points[0]!.ts).toFixed(1)
    const lastX  = xScale(points[points.length - 1]!.ts).toFixed(1)
    const bottomY = (PAD.top + chartH).toFixed(1)
    areaPath = `M${firstX},${bottomY} L${pts.join(' L')} L${lastX},${bottomY} Z`
  }

  // Cap line Y position
  const capY = hardCapUsd != null ? yScale(hardCapUsd).toFixed(1) : null

  return (
    <div className="w-full">
      <div className="mb-1 flex items-center justify-between text-xs text-slate-500">
        <span>Burn ({label})</span>
        {hardCapUsd != null && (
          <span className="font-mono text-amber-600">Cap: ${hardCapUsd.toFixed(2)}</span>
        )}
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`}
        aria-label={`Cost burn chart, ${label} window`}
        className="w-full"
        style={{ height }}
      >
        {/* Grid lines */}
        {[0.25, 0.5, 0.75, 1.0].map((frac) => {
          const y = (PAD.top + chartH * (1 - frac)).toFixed(1)
          const val = (maxCost * frac).toFixed(4)
          return (
            <g key={frac}>
              <line
                x1={PAD.left}
                y1={y}
                x2={PAD.left + chartW}
                y2={y}
                stroke="#e2e8f0"
                strokeWidth="1"
              />
              <text
                x={PAD.left - 4}
                y={y}
                textAnchor="end"
                dominantBaseline="middle"
                fontSize="9"
                fill="#94a3b8"
              >
                ${val}
              </text>
            </g>
          )
        })}

        {/* Area fill */}
        {hasData && (
          <path d={areaPath} fill="rgba(99,102,241,0.15)" />
        )}

        {/* Stroke line */}
        {hasData && (
          <polyline
            points={points.map((p) => `${xScale(p.ts).toFixed(1)},${yScale(p.costUsd).toFixed(1)}`).join(' ')}
            fill="none"
            stroke="#6366f1"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
        )}

        {/* Hard cap dashed line */}
        {capY != null && (
          <line
            x1={PAD.left}
            y1={capY}
            x2={PAD.left + chartW}
            y2={capY}
            stroke="#f59e0b"
            strokeWidth="1.5"
            strokeDasharray="4 3"
          />
        )}

        {/* No-data message */}
        {!hasData && (
          <text
            x={W / 2}
            y={H / 2}
            textAnchor="middle"
            dominantBaseline="middle"
            fontSize="11"
            fill="#94a3b8"
          >
            No cost data yet
          </text>
        )}
      </svg>
    </div>
  )
}
