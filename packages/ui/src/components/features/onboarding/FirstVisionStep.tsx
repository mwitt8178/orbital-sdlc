/**
 * FirstVisionStep — Step 5 (Live mode): a giant textarea where the user
 * types what they want to build. Submits via vision.start.
 */

import { useState, type KeyboardEvent } from 'react'
import { trpc } from '../../../services/trpc.js'
import { Button } from '../../ui/Button.js'

interface Props {
  installId: string
  onStarted: (visionDocumentId: string, visionSessionId: string) => void
}

export function FirstVisionStep({ installId, onStarted }: Props) {
  const [prompt, setPrompt] = useState('')
  const [errorMessage, setErrorMessage] = useState<string | null>(null)

  const startMutation = trpc.vision.start.useMutation({
    onSuccess: (data) => {
      onStarted(data.vision_document_id, data.vision_session_id)
    },
    onError: (err) => {
      setErrorMessage(err.message)
    },
  })

  const submit = () => {
    if (prompt.trim().length === 0 || startMutation.isPending) return
    setErrorMessage(null)
    startMutation.mutate({
      title: derivedTitle(prompt),
      initial_prompt: prompt,
      audit_metadata: {
        actor: { type: 'user', user_id: 'wizard-user', install_id: installId },
        justification: 'First vision started from onboarding wizard',
        trace_id: `wizard-vision-${Date.now()}`,
        linked_artifacts: [],
      },
    })
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      submit()
    }
  }

  return (
    <div>
      <h1 className="mb-2 text-2xl font-bold text-slate-900">What do you want to build?</h1>
      <p className="mb-6 text-sm text-slate-500">
        Describe it freely. The PM persona will ask follow-ups.
      </p>

      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        onKeyDown={onKeyDown}
        rows={8}
        placeholder="I want a recipe app where users save and share their family recipes."
        aria-label="Initial vision prompt"
        className="w-full resize-y rounded-lg border border-slate-200 bg-white p-4 text-base text-slate-900 placeholder-slate-400 shadow-none transition focus:border-transparent focus:outline-none focus:ring-2 focus:ring-brand-500"
        disabled={startMutation.isPending}
      />

      <div className="mt-3 flex items-center justify-between">
        <p className="text-xs text-slate-500">
          Press <kbd className="rounded border border-slate-200 bg-slate-50 px-1 py-0.5 font-mono text-[10px]">⌘ Enter</kbd> to start.
        </p>
        <Button
          variant="primary"
          size="lg"
          onClick={submit}
          disabled={prompt.trim().length === 0 || startMutation.isPending}
          className="bg-brand-600 hover:bg-brand-700 active:bg-brand-800"
        >
          {startMutation.isPending ? 'Starting…' : 'Start vision intake'}
        </Button>
      </div>

      {errorMessage && (
        <p className="mt-3 text-xs text-rose-600" role="alert">
          {errorMessage}
        </p>
      )}
    </div>
  )
}

/** Best-effort derive a 60-char title from the first sentence of the prompt. */
function derivedTitle(prompt: string): string {
  const firstSentence = prompt.split(/[.!?\n]/, 1)[0] ?? prompt
  const trimmed = firstSentence.trim().replace(/^I want (a |an |to )?/i, '').trim()
  return trimmed.slice(0, 60) || 'Untitled vision'
}
