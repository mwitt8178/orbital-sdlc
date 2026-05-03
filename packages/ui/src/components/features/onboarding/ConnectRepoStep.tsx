/**
 * ConnectRepoStep — Flow B step 1: pick the GitHub repo + Monday board to import.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 */

import { useEffect, useState } from 'react'
import { InlineValidationField } from '../../ui/InlineValidationField.js'
import { TimeEstimateBadge } from '../../ui/TimeEstimateBadge.js'

export interface ConnectRepoData {
  githubOwner: string
  githubRepo: string
  mondayBoardId: string
}

interface Props {
  initial?: ConnectRepoData
  onChange: (next: ConnectRepoData, valid: boolean) => void
}

export function ConnectRepoStep({ initial, onChange }: Props) {
  const [owner, setOwner] = useState(initial?.githubOwner ?? '')
  const [repo, setRepo] = useState(initial?.githubRepo ?? '')
  const [boardId, setBoardId] = useState(initial?.mondayBoardId ?? '')

  const valid = owner.trim().length > 0 && repo.trim().length > 0

  useEffect(() => {
    onChange({ githubOwner: owner, githubRepo: repo, mondayBoardId: boardId }, valid)
  }, [owner, repo, boardId, valid, onChange])

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Connect your repo</h1>
        <TimeEstimateBadge estSeconds={60} />
      </div>
      <p className="mb-6 text-sm text-slate-500">
        Point Orbital at the repo + board you already use. We'll learn from them.
      </p>

      <div className="space-y-4">
        <div className="grid gap-4 md:grid-cols-2">
          <InlineValidationField
            label="GitHub owner"
            placeholder="mwitt"
            value={owner}
            onValueChange={setOwner}
            validate={(v) => (v.trim().length === 0 ? 'Required.' : null)}
          />
          <InlineValidationField
            label="GitHub repo"
            placeholder="apprentice"
            value={repo}
            onValueChange={setRepo}
            validate={(v) => (v.trim().length === 0 ? 'Required.' : null)}
          />
        </div>

        <InlineValidationField
          label="Monday board id (optional)"
          placeholder="1234567890"
          value={boardId}
          onValueChange={setBoardId}
          helperText="Skip if you don't use Monday — Orbital can use an internal backlog instead."
        />
      </div>
    </div>
  )
}
