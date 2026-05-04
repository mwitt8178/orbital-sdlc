/**
 * cost/categories.ts — derive a billing category from a cost_ledger row.
 *
 * [Engineer-Principal · Opus · run-settings-billing]
 *
 * Categories used by /settings/billing breakdown:
 *   - story-execution  → engineer/dev personas writing code
 *   - planning         → product, planner, principal-dev (architecture)
 *   - code-review      → reviewer / verifier / qa
 *   - other            → fallback for system / orchestration calls
 *
 * The mapping is intentionally explicit (not config-driven) so it is unit
 * testable and stable across deploys. New persona ids must be added here
 * to land in the right slice; until then they fall through to "other".
 */

export type BillingCategory =
  | 'story-execution'
  | 'planning'
  | 'code-review'
  | 'other'

export const BILLING_CATEGORIES: BillingCategory[] = [
  'story-execution',
  'planning',
  'code-review',
  'other',
]

/**
 * Classify a cost_ledger row by persona_id (and task_id as a fallback signal
 * — a row with a task_id but no persona_id is almost certainly a coding-agent
 * call that didn't tag itself).
 */
export function categorize(input: {
  personaId: string | null
  taskId: string | null
}): BillingCategory {
  const persona = input.personaId?.toLowerCase() ?? null

  if (persona !== null) {
    if (persona === 'sr-dev' || persona === 'jr-dev' || persona === 'engineer-sr' || persona === 'engineer-jr' || persona === 'coding-agent') {
      return 'story-execution'
    }
    if (persona === 'principal-dev' || persona === 'engineer-principal' || persona === 'product' || persona === 'product-agent' || persona === 'planner' || persona === 'architect') {
      return 'planning'
    }
    if (persona === 'reviewer' || persona === 'verifier' || persona === 'qa' || persona === 'qa-agent' || persona === 'review-agent' || persona === 'security') {
      return 'code-review'
    }
  }

  // Untagged rows linked to a story are story-execution by default.
  if (input.taskId !== null) return 'story-execution'

  return 'other'
}
