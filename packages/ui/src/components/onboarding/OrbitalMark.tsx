/**
 * OrbitalMark — brand mark used in onboarding shell + welcome hero.
 * [Engineer-Principal · Opus · run-orbital-onboarding-rework]
 */

interface Props {
  size?: number
  className?: string
}

export function OrbitalMark({ size = 32, className }: Props) {
  return (
    <span
      className={className}
      style={{ width: size, height: size, display: 'inline-flex' }}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 32 32"
        width={size}
        height={size}
        xmlns="http://www.w3.org/2000/svg"
        role="img"
      >
        <defs>
          <linearGradient id="orbital-mark-grad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
            <stop offset="0%" stopColor="oklch(52% 0.225 290)" />
            <stop offset="100%" stopColor="oklch(64% 0.2 200)" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="8" fill="url(#orbital-mark-grad)" />
        <circle cx="16" cy="16" r="3" fill="white" />
        <ellipse
          cx="16"
          cy="16"
          rx="9"
          ry="4"
          fill="none"
          stroke="white"
          strokeWidth="1.5"
          strokeOpacity="0.85"
          transform="rotate(-30 16 16)"
        />
        <ellipse
          cx="16"
          cy="16"
          rx="9"
          ry="4"
          fill="none"
          stroke="white"
          strokeWidth="1.5"
          strokeOpacity="0.55"
          transform="rotate(30 16 16)"
        />
      </svg>
    </span>
  )
}
