/**
 * types/events.ts — UI-side event payload types.
 *
 * Mirror of the orchestrator's event payload shapes that the UI consumes
 * over WebSocket. Kept here (not imported from orchestrator) because the
 * UI bundle must not depend on Node.js server packages.
 *
 * [Engineer-Sr · Sonnet · run-round6-05-cost-governance]
 */

// ---------------------------------------------------------------------------
// Round 6 #5 — Cost Governance event payloads
// ---------------------------------------------------------------------------

export interface CostLedgerAppendedPayload {
  entry_id:           string
  project_id:         string
  sprint_id:          string | null
  task_id:            string | null
  worker_id:          string | null
  persona_id:         string | null
  model:              string
  provider:           string
  input_tokens:       number
  output_tokens:      number
  cache_read_tokens:  number
  cache_write_tokens: number
  cost_usd:           number
  occurred_at:        string
}

export interface BudgetExceededPayload {
  scope:            string
  scope_id:         string
  running_cost_usd: number
  hard_cap_usd:     number
  occurred_at:      string
}

export interface KillSwitchTrippedPayload {
  worker_id: string
  scope:     string
  scope_id:  string
  reason:    string
  actor_id:  string
  killed_at: string
}
