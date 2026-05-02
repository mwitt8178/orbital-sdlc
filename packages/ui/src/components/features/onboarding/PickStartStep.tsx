/**
 * PickStartStep — Step 4: Start fresh / Load Acme sample / Resume.
 */

import clsx from 'clsx'

export type StartChoice = 'fresh' | 'sample' | 'resume'

interface Props {
  selected: StartChoice | null
  onSelect: (choice: StartChoice) => void
  /** When true, the Resume option is shown. */
  canResume: boolean
  isLoadingSample: boolean
  sampleLoadedAt: string | null
}

interface ChoiceCard {
  choice: StartChoice
  emoji: string
  title: string
  description: string
}

export function PickStartStep({
  selected,
  onSelect,
  canResume,
  isLoadingSample,
  sampleLoadedAt,
}: Props) {
  const choices: ChoiceCard[] = [
    {
      choice: 'fresh',
      emoji: '✨',
      title: 'Start fresh',
      description: 'Empty workspace. Define your first vision when ready.',
    },
    {
      choice: 'sample',
      emoji: '\u{1F4E6}',
      title: 'Load Acme Product sample',
      description:
        'A realistic billing-v2 sprint, 4 channels, retro proposals. Inspect without running anything.',
    },
  ]
  if (canResume) {
    choices.push({
      choice: 'resume',
      emoji: '⏱️',
      title: 'Resume',
      description: 'Continue with the data already in this install.',
    })
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-slate-900">Pick a starting point</h1>
      <p className="mb-8 text-sm text-slate-500">
        Choose what you want to see when you land on the dashboard.
      </p>

      <div role="radiogroup" aria-label="Starting point" className="grid gap-3">
        {choices.map((c) => {
          const isSelected = selected === c.choice
          return (
            <button
              key={c.choice}
              type="button"
              role="radio"
              aria-checked={isSelected}
              onClick={() => onSelect(c.choice)}
              className={clsx(
                'flex items-start gap-4 rounded-lg border p-5 text-left transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500',
                isSelected
                  ? 'border-brand-600 bg-brand-50 ring-2 ring-brand-600'
                  : 'border-slate-200 bg-white hover:border-brand-300 hover:bg-slate-50',
              )}
            >
              <span className="text-2xl" aria-hidden="true">
                {c.emoji}
              </span>
              <div className="flex-1">
                <h2 className="mb-0.5 text-sm font-semibold text-slate-900">{c.title}</h2>
                <p className="text-xs text-slate-600">{c.description}</p>
              </div>
            </button>
          )
        })}
      </div>

      {selected === 'sample' && (
        <p className="mt-4 text-xs text-slate-500" role="status" aria-live="polite">
          {isLoadingSample
            ? 'Loading sample dataset…'
            : sampleLoadedAt
              ? `Sample loaded ${new Date(sampleLoadedAt).toLocaleTimeString()}.`
              : "Click Continue to load the dataset."}
        </p>
      )}
    </div>
  )
}
