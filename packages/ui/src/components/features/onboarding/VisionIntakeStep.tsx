/**
 * VisionIntakeStep — capture the project's vision (free-form text → structured)
 * for the new-project flow.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Keeps the surface minimal — full vision document editing happens in /vision
 * after onboarding. This step only captures intent + chosen stack so the
 * downstream provisioners + memory seeder have what they need.
 */

import { useEffect, useState } from 'react'
import { TimeEstimateBadge } from '../../ui/TimeEstimateBadge.js'

export interface VisionIntakeData {
  intent: string
  stack: string[]
}

interface Props {
  initial?: VisionIntakeData
  onChange: (next: VisionIntakeData, valid: boolean) => void
}

const STACK_OPTIONS = [
  { id: 'nodejs', label: 'Node.js' },
  { id: 'typescript', label: 'TypeScript' },
  { id: 'react', label: 'React' },
  { id: 'tailwind', label: 'Tailwind v4' },
  { id: 'go', label: 'Go' },
  { id: 'python', label: 'Python' },
  { id: 'aws', label: 'AWS' },
]

export function VisionIntakeStep({ initial, onChange }: Props) {
  const [intent, setIntent] = useState(initial?.intent ?? '')
  const [stack, setStack] = useState<string[]>(
    initial?.stack ?? ['nodejs', 'typescript', 'react', 'tailwind'],
  )

  const valid = intent.trim().length >= 20 && stack.length > 0

  useEffect(() => {
    onChange({ intent, stack }, valid)
  }, [intent, stack, valid, onChange])

  const toggleStack = (id: string) => {
    setStack((prev) => (prev.includes(id) ? prev.filter((s) => s !== id) : [...prev, id]))
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Project vision</h1>
        <TimeEstimateBadge estSeconds={180} />
      </div>
      <p className="mb-6 text-sm text-slate-500">
        Two lines about what you're building. Agents read this on every brief.
      </p>

      <div className="space-y-5">
        <div>
          <label htmlFor="vision-intent" className="block text-sm font-medium text-slate-700">
            Intent
          </label>
          <textarea
            id="vision-intent"
            rows={5}
            value={intent}
            onChange={(e) => setIntent(e.target.value)}
            placeholder="e.g. A multi-tenant SaaS that lets ops teams replay incidents and watch agents propose fixes."
            className="mt-1 block w-full rounded-md border border-slate-300 px-3 py-2 text-sm focus:border-brand-500 focus:outline-none focus:ring-1 focus:ring-brand-500"
          />
          <p className="mt-1 text-xs text-slate-500">
            {intent.length < 20 ? `${20 - intent.length} more chars to lock.` : 'Locked.'}
          </p>
        </div>

        <div>
          <span className="block text-sm font-medium text-slate-700">Stack</span>
          <div className="mt-2 flex flex-wrap gap-2">
            {STACK_OPTIONS.map((opt) => {
              const selected = stack.includes(opt.id)
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => toggleStack(opt.id)}
                  aria-pressed={selected}
                  className={`rounded-full border px-3 py-1 text-xs font-medium transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-500 ${
                    selected
                      ? 'border-brand-600 bg-brand-50 text-brand-700'
                      : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'
                  }`}
                >
                  {opt.label}
                </button>
              )
            })}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            Drives the .gitignore, the CI workflow, and the project CLAUDE.md.
          </p>
        </div>
      </div>
    </div>
  )
}
