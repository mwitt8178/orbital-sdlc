/**
 * testArtifactUtils.ts — Pure utility functions for TestArtifactsPanel.
 *
 * [Engineer-Sr · Sonnet · run-ac-test-generation]
 *
 * Extracted from the component so they can be unit-tested without a DOM.
 */

export type TestArtifactStatus = 'pending' | 'approved' | 'merged'

export interface TestArtifactSummary {
  id: string
  status: TestArtifactStatus
}

/**
 * Count artifacts with status = 'pending'.
 */
export function countPending(artifacts: TestArtifactSummary[]): number {
  return artifacts.filter((a) => a.status === 'pending').length
}

/**
 * Return true iff every artifact has status = 'merged'.
 */
export function allMerged(artifacts: TestArtifactSummary[]): boolean {
  return artifacts.length > 0 && artifacts.every((a) => a.status === 'merged')
}

/**
 * Return the Tailwind border + bg class for an artifact card based on status.
 */
export function artifactCardColorClass(status: TestArtifactStatus): string {
  if (status === 'pending') return 'border-amber-200 bg-amber-50/30'
  if (status === 'merged') return 'border-emerald-200 bg-emerald-50/30'
  return 'border-slate-200 bg-white'
}

/**
 * Toggle an ID's presence in an expanded-set.
 * Returns a new Set (immutable update).
 */
export function toggleExpanded(current: Set<string>, id: string): Set<string> {
  const next = new Set(current)
  if (next.has(id)) {
    next.delete(id)
  } else {
    next.add(id)
  }
  return next
}

/**
 * Determine whether the Approve + Reject buttons should be shown for an artifact.
 * Only pending artifacts with a project available can be actioned.
 */
export function canAction(status: TestArtifactStatus, projectId: string | null): boolean {
  return status === 'pending' && projectId !== null
}

/**
 * Determine whether the Generate button should be shown.
 * Requires a projectId to be present.
 */
export function canGenerate(projectId: string | null): boolean {
  return projectId !== null
}
