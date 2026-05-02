/**
 * LiveCostMeter — gauge component showing % of budget burned.
 *
 * Used in WorkerCard (compact) and the detail drawer (full).
 * Updates on CostLedgerAppended events (passed via props as pctUsed changes).
 *
 * [Engineer-Sr · Sonnet · run-round6-10-inspection]
 */

interface LiveCostMeterProps {
  /** 0.0 → 1.0 (clamped to [0, 1] for display). */
  pctUsed: number
  /** Actual cost in USD for the tooltip/label. */
  costUsd: number
  /** Hard cap in USD for context label. */
  hardCap: number
  /** Whether to show as compact (no label). Default false. */
  compact?: boolean
}

export function LiveCostMeter({ pctUsed, costUsd, hardCap, compact = false }: LiveCostMeterProps) {
  const clamped = Math.min(1, Math.max(0, pctUsed))
  const pct = Math.round(clamped * 100)

  const fillColor =
    clamped >= 0.9
      ? 'bg-red-500'
      : clamped >= 0.7
        ? 'bg-amber-500'
        : 'bg-emerald-500'

  return (
    <div className="w-full">
      {!compact && (
        <div className="mb-1 flex justify-between text-xs text-slate-500">
          <span>Budget</span>
          <span className="font-mono">${costUsd.toFixed(2)} / ${hardCap.toFixed(2)}</span>
        </div>
      )}
      <div
        role="meter"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={`${pct}% of budget used`}
        className="h-1.5 w-full overflow-hidden rounded-full bg-slate-100"
      >
        <div
          data-testid="cost-fill"
          className={`h-full rounded-full transition-all duration-500 ${fillColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      {!compact && (
        <div className="mt-0.5 text-right text-xs text-slate-400">
          {pct}%
        </div>
      )}
    </div>
  )
}
