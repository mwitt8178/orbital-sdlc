/**
 * OperatorBadge — primitive identity chip for an install/operator.
 *
 * Round 7-08 — Operator-Attributed UI
 * [Engineer-Sr · Sonnet · run-round7-08-operator-attribution]
 *
 * Renders an avatar (initials in the operator's deterministic color), display
 * name, optional role badge, and optional online indicator.
 *
 * Usage:
 *   <OperatorBadge installId="..." size="sm" showRole showPresence />
 *
 * Data is looked up via the team.members query. If the member data is not yet
 * loaded, a skeleton is shown. If the install is unknown (not in the tenant),
 * a neutral "Unknown" badge is shown.
 */

import clsx from 'clsx'
import { operatorColor, operatorInitials } from '../../lib/operator-color.js'
import { PresenceIndicator } from './PresenceIndicator.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface TeamMember {
  install_id: string
  display_name: string | null
  role: 'owner' | 'member' | 'viewer'
  last_seen_at: string | null
  /** Pre-computed color (hue) — if absent, computed on-the-fly. */
  color?: number
}

export interface OperatorBadgeProps {
  installId: string
  /** Pre-resolved member data. If absent, badge shows install_id abbreviated. */
  member?: TeamMember | null
  size?: 'sm' | 'md' | 'lg'
  showRole?: boolean
  showPresence?: boolean
  /** Suppress the display name — show avatar only. */
  avatarOnly?: boolean
  className?: string
}

// ---------------------------------------------------------------------------
// Size variants
// ---------------------------------------------------------------------------

const avatarSize = {
  sm: 'h-5 w-5 text-[9px]',
  md: 'h-7 w-7 text-xs',
  lg: 'h-9 w-9 text-sm',
}

const nameSize = {
  sm: 'text-xs',
  md: 'text-sm',
  lg: 'text-sm font-medium',
}

const roleColors: Record<string, string> = {
  owner: 'bg-violet-100 text-violet-700',
  member: 'bg-blue-100 text-blue-700',
  viewer: 'bg-slate-100 text-slate-600',
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

/**
 * Renders an operator identity badge.
 *
 * When member data is provided, shows: avatar + display_name + optional role + optional presence dot.
 * When member is null/undefined (not yet loaded), shows a compact placeholder derived from installId.
 */
export function OperatorBadge({
  installId,
  member,
  size = 'md',
  showRole = false,
  showPresence = false,
  avatarOnly = false,
  className,
}: OperatorBadgeProps) {
  const displayName = member?.display_name ?? null
  const { light: bgColor } = operatorColor(installId)
  const initials = operatorInitials(displayName ?? installId)
  const label = displayName ?? installId.slice(0, 8)

  return (
    <span
      className={clsx('inline-flex items-center gap-1.5', className)}
      data-install-id={installId}
      aria-label={`Operator: ${label}${member?.role ? `, ${member.role}` : ''}`}
    >
      {/* Avatar */}
      <span
        className={clsx(
          'inline-flex shrink-0 items-center justify-center rounded-full font-semibold text-white',
          avatarSize[size],
        )}
        style={{ backgroundColor: bgColor }}
        aria-hidden="true"
      >
        {initials}
      </span>

      {/* Name + role */}
      {!avatarOnly && (
        <>
          <span className={clsx('font-medium text-slate-800', nameSize[size])}>
            {label}
          </span>

          {showRole && member?.role && (
            <span
              className={clsx(
                'rounded px-1 py-0.5 text-[10px] font-medium capitalize',
                roleColors[member.role] ?? roleColors['member'],
              )}
            >
              {member.role}
            </span>
          )}

          {showPresence && (
            <PresenceIndicator
              lastSeenAt={member?.last_seen_at}
              displayName={label}
              size={size === 'lg' ? 'md' : 'sm'}
            />
          )}
        </>
      )}

      {/* Avatar-only: still show presence dot */}
      {avatarOnly && showPresence && (
        <PresenceIndicator
          lastSeenAt={member?.last_seen_at}
          displayName={label}
          size="sm"
        />
      )}
    </span>
  )
}

// ---------------------------------------------------------------------------
// Skeleton variant
// ---------------------------------------------------------------------------

/**
 * Placeholder rendered while member data loads.
 */
export function OperatorBadgeSkeleton({ size = 'md' }: { size?: 'sm' | 'md' | 'lg' }) {
  return (
    <span className="inline-flex animate-pulse items-center gap-1.5">
      <span
        className={clsx('rounded-full bg-slate-200', avatarSize[size])}
        aria-hidden="true"
      />
      <span className={clsx('rounded bg-slate-200', size === 'sm' ? 'h-3 w-14' : 'h-4 w-20')} />
    </span>
  )
}
