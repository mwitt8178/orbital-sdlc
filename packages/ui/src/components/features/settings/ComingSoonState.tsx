/**
 * ComingSoonState — designed empty state for settings sub-pages whose
 * implementation hasn't landed yet. NOT a stub or "TBD" page.
 *
 * [Engineer-Principal · Opus · run-orbital-onboarding-rework]
 */

import { motion } from 'framer-motion'
import { DURATION, EASE } from '../../onboarding/motion.js'

interface Props {
  title: string
  description: string
  /** Optional secondary CTA — e.g. linking to where similar functionality lives today. */
  actionLabel?: string
  actionHref?: string
  eta?: string
}

export function ComingSoonState({ title, description, actionLabel, actionHref, eta }: Props) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 6 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: DURATION.slow, ease: EASE.out }}
      className="overflow-hidden rounded-card-lg border border-slate-200 bg-white shadow-card"
    >
      <div className="hero-grid flex flex-col items-center px-6 py-12 text-center md:py-16">
        <span className="mb-4 inline-flex h-12 w-12 items-center justify-center rounded-full bg-brand-100 text-brand-700">
          <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
        </span>
        <h3 className="text-display-md text-slate-900">{title}</h3>
        <p className="mt-3 max-w-md text-sm leading-relaxed text-slate-600">{description}</p>
        {eta && (
          <span className="mt-4 inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-700 ring-1 ring-amber-200">
            <span className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500" />
            ETA · {eta}
          </span>
        )}
        {actionLabel && actionHref && (
          <a
            href={actionHref}
            className="mt-5 inline-flex items-center gap-1 rounded-md bg-brand-600 px-3 py-1.5 text-sm font-medium text-white shadow-card hover:bg-brand-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 focus-visible:ring-offset-2"
          >
            {actionLabel}
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <line x1="5" y1="12" x2="19" y2="12" />
              <polyline points="12 5 19 12 12 19" />
            </svg>
          </a>
        )}
      </div>
    </motion.div>
  )
}
