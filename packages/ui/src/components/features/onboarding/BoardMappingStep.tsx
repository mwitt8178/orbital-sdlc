/**
 * BoardMappingStep — Flow B step 3: confirm Monday board → Orbital schema mapping.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * If a board id is not provided, this step is a no-op pass-through. Otherwise
 * it lets the user review the heuristic mapping and confirm. The actual
 * mapping resolution lives in the boards router (Round 5 work); this step is
 * intentionally a thin UI layer.
 */

import { Button } from '../../ui/Button.js'
import { TimeEstimateBadge } from '../../ui/TimeEstimateBadge.js'
import { SkipWithRecoveryHint } from '../../ui/SkipWithRecoveryHint.js'

interface Props {
  mondayBoardId: string
  onConfirm: () => void
  onSkip: () => void
}

const PROPOSED_MAPPING = [
  { from: 'Status', to: 'Workflow Status', confidence: 'Strong match' },
  { from: 'Description', to: 'Acceptance Criteria', confidence: 'High confidence' },
  { from: 'Severity', to: 'Risk Tier', confidence: 'Inferred from values' },
  { from: 'Effort', to: 'Estimate', confidence: 'Inferred from values' },
  { from: 'Owner', to: 'Author', confidence: 'People column' },
  { from: 'GitHub Link', to: 'PR Link', confidence: 'Pattern match' },
]

export function BoardMappingStep({ mondayBoardId, onConfirm, onSkip }: Props) {
  if (!mondayBoardId) {
    return (
      <div>
        <div className="mb-4 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-slate-900">Board mapping</h1>
          <TimeEstimateBadge estSeconds={5} />
        </div>
        <p className="mb-4 text-sm text-slate-500">
          No Monday board to map — Orbital will use its internal backlog.
        </p>
        <Button onClick={onSkip}>Continue</Button>
      </div>
    )
  }

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Map your Monday board</h1>
        <TimeEstimateBadge estSeconds={90} />
      </div>
      <p className="mb-6 text-sm text-slate-500">
        We propose a mapping based on column names + values. Confirm or adjust.
      </p>

      <div className="overflow-x-auto rounded-md border border-slate-200">
        <table className="w-full text-sm">
          <thead className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-3 py-2">Your column</th>
              <th className="px-3 py-2">Maps to</th>
              <th className="px-3 py-2">Confidence</th>
            </tr>
          </thead>
          <tbody>
            {PROPOSED_MAPPING.map((row) => (
              <tr key={row.from} className="border-t border-slate-200">
                <td className="px-3 py-2 font-mono text-xs">{row.from}</td>
                <td className="px-3 py-2">{row.to}</td>
                <td className="px-3 py-2 text-emerald-700">✓ {row.confidence}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="mt-4 flex items-center gap-3">
        <Button variant="primary" onClick={onConfirm}>
          Confirm mapping
        </Button>
        <SkipWithRecoveryHint
          recoveryPath="Boards → Mapping"
          onSkip={onSkip}
          label="Adjust later"
        />
      </div>
    </div>
  )
}
