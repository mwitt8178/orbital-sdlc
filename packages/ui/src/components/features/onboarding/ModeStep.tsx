/**
 * ModeStep — Step 2 of the onboarding wizard.
 *
 * User picks demo / live / readonly. Selection is bubbled up to the parent.
 */

import clsx from 'clsx'
import type { OnboardingMode } from '../../../services/onboarding-types.js'

interface Props {
  selected: OnboardingMode | null
  onSelect: (mode: OnboardingMode) => void
}

interface ModeCard {
  mode: OnboardingMode
  emoji: string
  title: string
  recommended?: boolean
  description: string
}

const CARDS: ModeCard[] = [
  {
    mode: 'demo',
    emoji: '\u{1F3AC}',
    title: 'Demo mode',
    description:
      'Watch a pre-recorded sprint replay end-to-end. No tokens, no agents. Best for evaluation.',
  },
  {
    mode: 'live',
    emoji: '\u{1F680}',
    title: 'Live mode',
    recommended: true,
    description:
      'Connect your Anthropic key. Real agents do real work. ~$0.20 per ticket.',
  },
  {
    mode: 'readonly',
    emoji: '\u{1F50D}',
    title: 'Read-only mode',
    description:
      'Connect to an existing install’s database to observe — no agent activity from this session.',
  },
]

export function ModeStep({ selected, onSelect }: Props) {
  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-slate-900">Pick a mode</h1>
      <p className="mb-8 text-sm text-slate-500">
        You can change this later from Settings.
      </p>

      <div role="radiogroup" aria-label="Mode" className="grid gap-3 md:grid-cols-3">
        {CARDS.map((card) => {
          const isSelected = selected === card.mode
          return (
            <button
              key={card.mode}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => onSelect(card.mode)}
              className={clsx(
                'group flex flex-col items-start rounded-lg border p-5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                isSelected
                  ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-600'
                  : 'border-slate-200 bg-white hover:border-brand-300 hover:bg-slate-50',
              )}
            >
              <div className="mb-3 flex w-full items-start justify-between">
                <span className="text-2xl" aria-hidden="true">
                  {card.emoji}
                </span>
                {card.recommended && (
                  <span className="rounded-full bg-brand-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-brand-700">
                    Recommended
                  </span>
                )}
              </div>
              <h2 className="mb-1 text-sm font-semibold text-slate-900">{card.title}</h2>
              <p className="text-xs leading-relaxed text-slate-600">{card.description}</p>
            </button>
          )
        })}
      </div>
    </div>
  )
}
