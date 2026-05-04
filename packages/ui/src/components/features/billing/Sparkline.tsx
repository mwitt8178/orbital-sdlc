/**
 * Sparkline — dependency-free SVG sparkline.
 *
 * Renders a polyline + filled area for a daily-spend series.
 *
 * [Engineer-Principal · Opus · run-settings-billing]
 */

interface Point {
  date: string
  costUsd: number
}

interface Props {
  points: Point[]
  width?: number
  height?: number
  className?: string
  ariaLabel?: string
}

export function Sparkline({
  points,
  width = 280,
  height = 56,
  className = '',
  ariaLabel = 'Daily spend sparkline',
}: Props) {
  if (points.length === 0) {
    return (
      <svg
        viewBox={`0 0 ${width} ${height}`}
        className={className}
        style={{ width: '100%', height }}
        aria-label={ariaLabel}
      >
        <text x={width / 2} y={height / 2} textAnchor="middle" fontSize="10" fill="#94a3b8">
          No spend yet
        </text>
      </svg>
    )
  }

  const max = Math.max(...points.map((p) => p.costUsd), 0.0001)
  const stepX = width / Math.max(1, points.length - 1)

  const coords = points.map((p, i) => {
    const x = i * stepX
    const y = height - (p.costUsd / max) * (height - 4) - 2
    return [x, y] as const
  })

  const polyline = coords.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area =
    `M0,${height} ` +
    coords.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join(' ') +
    ` L${(coords[coords.length - 1]?.[0] ?? 0).toFixed(1)},${height} Z`

  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      style={{ width: '100%', height }}
      aria-label={ariaLabel}
      role="img"
    >
      <path d={area} fill="rgba(99,102,241,0.15)" />
      <polyline
        points={polyline}
        fill="none"
        stroke="#6366f1"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
    </svg>
  )
}
