/**
 * OpenQuestionsPanel — checklist-style render of the vision document's
 * open_questions[]. Marking a question "resolved" posts a chat message to
 * the PM persona via the parent's onResolve callback (no dedicated
 * resolveQuestion mutation exists yet — the persona incorporates the
 * resolution into the next draft).
 */

import { useState } from 'react'

interface OpenQuestion {
  id: string
  text: string
  resolved: boolean
}

interface Props {
  questions: OpenQuestion[]
  onResolve: (questionText: string) => void
  disabled?: boolean
}

export function OpenQuestionsPanel({ questions, onResolve, disabled }: Props) {
  const [resolving, setResolving] = useState<string | null>(null)

  if (questions.length === 0) {
    return <p className="text-xs text-slate-500">No open questions.</p>
  }

  return (
    <ul className="space-y-2" aria-label="Open questions">
      {questions.map((q) => (
        <li key={q.id} className="flex items-start gap-2">
          <input
            type="checkbox"
            id={`oq-${q.id}`}
            checked={q.resolved || resolving === q.id}
            disabled={disabled || q.resolved || resolving === q.id}
            onChange={() => {
              if (q.resolved || disabled) return
              setResolving(q.id)
              onResolve(q.text)
            }}
            className="mt-0.5 h-4 w-4 rounded border-slate-300 text-indigo-600 focus:ring-indigo-500 disabled:opacity-60"
            aria-label={`Mark resolved: ${q.text}`}
          />
          <label
            htmlFor={`oq-${q.id}`}
            className={`text-sm ${q.resolved ? 'text-slate-400 line-through' : 'text-slate-700'}`}
          >
            {q.text}
          </label>
        </li>
      ))}
    </ul>
  )
}
