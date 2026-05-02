/**
 * OperatorFilter — filter chip "All / Mine / Specific operator".
 *
 * Round 7-08 — Operator-Attributed UI
 * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
 *
 * Renders a compact row of filter chips. Consumers pass in the member list and
 * the current install_id ("mine"), and receive the selected filter value via
 * onChange.
 *
 * Filter values:
 *   'all'         — no filter; show everything
 *   'mine'        — show only items owned by my install_id
 *   <install_id>  — show only items owned by that specific operator
 */

import clsx from 'clsx'
import { operatorColor, operatorInitials } from '../../lib/operator-color.js'
import type { TeamMember } from './OperatorBadge.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OperatorFilterValue = 'all' | 'mine' | string

export interface OperatorFilterProps {
  /** Current filter value. */
  value: OperatorFilterValue
  /** Called when the filter changes. */
  onChange: (value: OperatorFilterValue) => void
  /** All team members to show as specific-operator chips. */
  members: TeamMember[]
  /** The current install's install_id — determines which chip is "Mine". */
  myInstallId: string
  /** Additional CSS classes. */
  className?: string
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * A compact row of filter chips for narrowing a list to a specific operator.
 *
 * Chips: [All] [Mine] [<avatar> operator-1] [<avatar> operator-2] ...
 * Renders only "All" and "Mine" when there is one member (just the current install).
 */
export function OperatorFilter({
  value,
  onChange,
  members,
  myInstallId,
  className,
}: OperatorFilterProps) {
  // Sort: current install first, then alphabetical
  const sorted = [...members].sort((a, b) => {
    if (a.install_id === myInstallId) return -1
    if (b.install_id === myInstallId) return 1
    const aName = a.display_name ?? a.install_id
    const bName = b.display_name ?? b.install_id
    return aName.localeCompare(bName)
  })

  // Other operators (not "mine") — only render if there are others
  const others = sorted.filter((m) => m.install_id !== myInstallId)

  function chipClass(active: boolean) {
    return clsx(
      'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
      active
        ? 'border-brand-500 bg-brand-50 text-brand-700'
        : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50',
    )
  }

  return (
    <div
      className={clsx('flex flex-wrap items-center gap-1.5', className)}
      role="group"
      aria-label="Filter by operator"
    >
      {/* All */}
      <button
        type="button"
        className={chipClass(value === 'all')}
        onClick={() => onChange('all')}
        aria-pressed={value === 'all'}
      >
        All
      </button>

      {/* Mine */}
      <button
        type="button"
        className={chipClass(value === 'mine')}
        onClick={() => onChange('mine')}
        aria-pressed={value === 'mine'}
      >
        Mine
      </button>

      {/* Specific operators */}
      {others.map((member) => {
        const { light: bgColor } = operatorColor(member.install_id)
        const initials = operatorInitials(member.display_name ?? member.install_id)
        const label = member.display_name ?? member.install_id.slice(0, 8)
        const isActive = value === member.install_id

        return (
          <button
            key={member.install_id}
            type="button"
            className={chipClass(isActive)}
            onClick={() => onChange(member.install_id)}
            aria-pressed={isActive}
            aria-label={`Filter by ${label}`}
          >
            <span
              className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-bold text-white"
              style={{ backgroundColor: bgColor }}
              aria-hidden="true"
            >
              {initials}
            </span>
            {label}
          </button>
        )
      })}
    </div>
  )
}
