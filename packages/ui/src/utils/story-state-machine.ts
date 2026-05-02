/**
 * utils/story-state-machine.ts — UI mirror of the server-side STORY_TRANSITIONS
 * map (orchestrator/src/backlog/types.ts).
 *
 * Used by the StoryDrawer to populate the status dropdown with only valid next
 * states for the current state. Keeping the map UI-side avoids a server
 * round-trip on every drawer render.
 *
 * If the server map changes, this file MUST be updated. A round-trip unit
 * test asserts the canonical transitions.
 */

import type { BacklogStoryStatus } from '../store/backlog.js'

const STORY_TRANSITIONS: Record<BacklogStoryStatus, BacklogStoryStatus[]> = {
  backlog: ['ready'],
  ready: ['in_progress', 'blocked'],
  in_progress: ['in_review', 'blocked'],
  in_review: ['done'],
  done: ['accepted', 'defective'],
  accepted: [],
  blocked: ['in_progress', 'ready'],
  defective: ['backlog'],
  cancelled: [],
}

/**
 * Returns the set of statuses the user can transition to from `current`.
 * Includes `current` itself first so the dropdown's selected value remains
 * valid when no change is intended.
 */
export function getValidNextStatuses(current: BacklogStoryStatus): BacklogStoryStatus[] {
  const next = STORY_TRANSITIONS[current] ?? []
  return [current, ...next]
}

export function isValidStoryTransition(
  from: BacklogStoryStatus,
  to: BacklogStoryStatus,
): boolean {
  if (from === to) return true
  return (STORY_TRANSITIONS[from] ?? []).includes(to)
}

/**
 * Some transitions require linked artifacts (per server-side
 * BacklogService.linkedArtifactRequirement):
 *   - in_review -> done    requires "pr" or "commit"
 *   - done -> accepted     requires "uat_result"
 *   - done -> defective    requires "defect" or "failed_ac_id"
 *
 * The drawer uses this to show an inline "linked artifact required" notice
 * before letting the user submit.
 */
export function transitionRequiresLinkedArtifact(
  from: BacklogStoryStatus,
  to: BacklogStoryStatus,
): string[] | null {
  if (from === 'in_review' && to === 'done') return ['pr', 'commit']
  if (from === 'done' && to === 'accepted') return ['uat_result']
  if (from === 'done' && to === 'defective') return ['defect', 'failed_ac_id']
  return null
}

/**
 * Story-status badge color mapping. Centralised here so EpicCard, StoryRow,
 * and StoryDrawer agree.
 */
export function statusBadgeColor(
  status: BacklogStoryStatus,
):
  | 'slate'
  | 'amber'
  | 'blue'
  | 'indigo'
  | 'emerald'
  | 'rose'
  | 'violet' {
  switch (status) {
    case 'backlog':
      return 'slate'
    case 'ready':
      return 'amber'
    case 'in_progress':
      return 'blue'
    case 'in_review':
      return 'indigo'
    case 'done':
      return 'violet'
    case 'accepted':
      return 'emerald'
    case 'blocked':
      return 'rose'
    case 'defective':
      return 'rose'
    case 'cancelled':
      return 'slate'
  }
}

/**
 * Human-readable status label.
 */
export function statusLabel(status: BacklogStoryStatus): string {
  switch (status) {
    case 'in_progress':
      return 'In progress'
    case 'in_review':
      return 'In review'
    default:
      return status.charAt(0).toUpperCase() + status.slice(1)
  }
}
