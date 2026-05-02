/**
 * WelcomeStep — Step 1 of the onboarding wizard.
 *
 * Hero card with the Orbital tagline + three feature pillars.
 */

import { ReactNode } from 'react'

interface Pillar {
  title: string
  description: string
  icon: ReactNode
}

const PILLARS: Pillar[] = [
  {
    title: 'Event-sourced',
    description:
      'Every action is an immutable event. Replay any sprint exactly as it happened.',
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <line x1="3" y1="12" x2="21" y2="12" />
        <line x1="3" y1="6" x2="21" y2="6" />
        <line x1="3" y1="18" x2="21" y2="18" />
      </svg>
    ),
  },
  {
    title: 'Capability-gated',
    description:
      'Agents only do what they are explicitly granted. No shadow privileges.',
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
      </svg>
    ),
  },
  {
    title: 'Auditable',
    description:
      'Every decision is signed, attested, and queryable. Drift detection is built in.',
    icon: (
      <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14" />
        <polyline points="22 4 12 14.01 9 11.01" />
      </svg>
    ),
  },
]

export function WelcomeStep() {
  return (
    <div className="text-center">
      <div className="mx-auto mb-6 flex h-14 w-14 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-violet-600">
        <svg
          width="28"
          height="28"
          viewBox="0 0 24 24"
          fill="none"
          stroke="white"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <circle cx="12" cy="12" r="3" />
          <path d="M12 2a10 10 0 0 1 8.66 5" />
          <path d="M22 12a10 10 0 0 1-5 8.66" />
          <path d="M12 22a10 10 0 0 1-8.66-5" />
          <path d="M2 12a10 10 0 0 1 5-8.66" />
        </svg>
      </div>
      <h1 className="mb-3 text-3xl font-bold tracking-tight text-slate-900">
        Welcome to Orbital.
      </h1>
      <p className="mx-auto mb-10 max-w-xl text-base text-slate-600">
        Turn &ldquo;I want to build X&rdquo; into shipping code via specialized AI agents you can
        audit.
      </p>

      <ul role="list" className="grid gap-4 text-left md:grid-cols-3">
        {PILLARS.map((p) => (
          <li
            key={p.title}
            role="listitem"
            className="rounded-lg border border-slate-200 bg-slate-50 p-4"
          >
            <div className="mb-2 inline-flex h-8 w-8 items-center justify-center rounded-md bg-white text-brand-600">
              {p.icon}
            </div>
            <h2 className="mb-1 text-sm font-semibold text-slate-900">{p.title}</h2>
            <p className="text-xs leading-relaxed text-slate-600">{p.description}</p>
          </li>
        ))}
      </ul>
    </div>
  )
}
