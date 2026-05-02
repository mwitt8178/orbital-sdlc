/**
 * Pure helpers for the NL ticket creator.
 *
 * The codebase doesn't include @testing-library/react, so any logic that
 * needs unit-test coverage lives in this pure module (matches the pattern in
 * KpiCards.test.tsx). The component file itself stays thin and presentational.
 */

import type { BacklogStoryStatus } from '../../../store/backlog.js'

/** Mirrors the backend Proposal shape (orchestrator/src/backlog/nl-parser.ts). */
export type ProposalKind = 'story' | 'bug' | 'epic'

export interface ProposalLike {
  kind: ProposalKind
  title: string
  description: string
  ac_titles: string[]
  suggested_epic_title: string | null
  priority: number
  story_points: number | null
  persona_of_record?: string
  bug?: { defect_id: string; severity: 'low' | 'medium' | 'high' | 'critical' }
  parser_engine: 'templated' | 'anthropic'
  rationale: string[]
}

export interface EditableProposal {
  kind: ProposalKind
  title: string
  description: string
  ac_titles: string[]
  /** Empty-string marker for "no epic chosen yet". */
  selected_epic_id: string
  priority: number
  story_points: number | null
}

export interface EpicOption {
  epicId: string
  title: string
}

/**
 * Build initial editable form state from a server-returned proposal.
 *
 * Resolves the suggested epic title (string) into the matching epicId from
 * the supplied list of available epics. Falls back to the first available
 * epic when no suggestion was given (so the user can still confirm a story
 * without a manual epic-pick step). For epic proposals the slot is empty
 * because creating an epic doesn't require a parent.
 */
export function toEditableProposal(
  proposal: ProposalLike,
  epics: EpicOption[],
): EditableProposal {
  let selected_epic_id = ''
  if (proposal.kind !== 'epic') {
    if (proposal.suggested_epic_title) {
      const match = epics.find((e) => e.title === proposal.suggested_epic_title)
      if (match) selected_epic_id = match.epicId
    }
    if (!selected_epic_id && epics.length > 0) {
      selected_epic_id = epics[0]?.epicId ?? ''
    }
  }
  return {
    kind: proposal.kind,
    title: proposal.title,
    description: proposal.description,
    ac_titles: [...proposal.ac_titles],
    selected_epic_id,
    priority: proposal.priority,
    story_points: proposal.story_points,
  }
}

/**
 * Compute whether the current edit state is valid for submission.
 *   - story / bug must have a selected epic and non-empty title + at least 1 AC
 *   - epic must have a non-empty title and rationale (description)
 */
export function isProposalValid(p: EditableProposal): boolean {
  if (!p.title.trim()) return false
  if (p.kind === 'epic') {
    return p.description.trim().length > 0
  }
  if (!p.selected_epic_id) return false
  const validAcs = p.ac_titles.filter((t) => t.trim().length > 0)
  if (validAcs.length === 0) return false
  return p.description.trim().length > 0
}

/**
 * Concise human-readable summary of the parser's classification, used as the
 * banner above the proposal card so the user understands why the parser
 * chose this kind. Strips internal engine labels.
 */
export function summarizeRationale(p: ProposalLike): string {
  const meaningful = p.rationale.filter(
    (r) => !/^engine=/i.test(r) && !/^forceKind/i.test(r),
  )
  if (meaningful.length === 0) return `Classified as a ${p.kind}.`
  // Just the first reason, capitalised.
  const first = meaningful[0] ?? ''
  return first.charAt(0).toUpperCase() + first.slice(1)
}

/**
 * Whether a status value can sensibly be displayed alongside this proposal.
 * (Currently always 'backlog' because the parser only creates new stories
 * which start in `backlog`. Helper exists so the drawer test surface can
 * extend it later.)
 */
export function initialStatusFor(_p: ProposalLike): BacklogStoryStatus {
  return 'backlog'
}
