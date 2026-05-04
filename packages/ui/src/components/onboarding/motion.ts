/**
 * Shared motion tokens for the onboarding rework.
 * [Engineer-Principal · Opus · run-orbital-onboarding-rework]
 *
 * Kept in JS (not CSS) because framer-motion variants need numeric values.
 * Mirrors the --duration-* CSS custom properties in index.css.
 */

import type { Transition, Variants } from 'framer-motion'

export const DURATION = {
  fast: 0.12,
  base: 0.2,
  slow: 0.36,
} as const

export const EASE = {
  out: [0.16, 1, 0.3, 1] as [number, number, number, number],
  inOut: [0.45, 0, 0.55, 1] as [number, number, number, number],
}

export const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 8 },
  visible: { opacity: 1, y: 0 },
}

export const stepTransition: Transition = {
  duration: DURATION.base,
  ease: EASE.out,
}

export const cardHoverTransition: Transition = {
  duration: DURATION.fast,
  ease: EASE.out,
}

export const stagger: Variants = {
  hidden: {},
  visible: {
    transition: { staggerChildren: 0.05, delayChildren: 0.05 },
  },
}
