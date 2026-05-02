# Round 6 — #5 Cost Governance + Hard Kill Switches

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: L

## Why
Token-budget references exist scattered across scheduler/routing/spawn but there are NO project- or sprint-level cost ceilings, NO auto-pause on overspend, NO operator-visible cost dashboard with live burn. For an unattended autonomous system, budget caps aren't a nice-to-have — they're the safety belt that lets the operator walk away.

## Independent of #1
Touches `scheduler.ts`/`pause.ts` BUT in different methods than #1's spawn-time work. To minimize collision: this wave runs AFTER #1 completes, in Wave 4 alone.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `cost` (NEW) | `packages/orchestrator/src/cost/{service.ts,types.ts,enforcer.ts,pricing.ts}` | Cost domain: pricing tables, budget enforcement, kill switches |
| `db schema` | NEW migration `0024_cost_budgets.sql` | `cost_budgets` (per-project, per-sprint) + `cost_ledger` (per-task, per-message) |
| `personas/anthropic-driver.ts` | existing | After each request, append cost ledger entry; check enforcer before next request |
| `orchestration/scheduler.ts` | existing | Before spawning, call `costEnforcer.canSpawn(projectId, sprintId, taskId, estimatedTokens)`. If `pause` recommended, do not spawn. |
| `orchestration/pause.ts` | existing | Add `pauseDueToCostCeiling(scope, reason)` method |
| `events` | new types: `CostLedgerAppended`, `BudgetExceeded`, `BudgetPaused`, `BudgetResumed`, `KillSwitchTripped` | Audit |
| `trpc` | NEW `cost.ts` router | `cost.summary({projectId, sprintId?})`, `cost.ledger({...})`, `cost.setBudget({scope, scope_id, hard_cap, soft_threshold})`, `cost.killAll({scope, scope_id, reason})` (capability-gated) |
| `mcp` | none — agents don't directly read cost; it's a system-level concern |
| `metrics` | existing instrumentation.ts | Emit cost metrics per task |
| `ui` | NEW `pages/Cost.tsx`, NEW `components/features/cost/*`, modify topbar | Live cost burn + budget management + kill switch |

## Data model
```sql
-- migration 0024_cost_budgets.sql
CREATE TABLE IF NOT EXISTS cost_budgets (
  budget_id      uuid        PRIMARY KEY,
  scope          text        NOT NULL CHECK (scope IN ('install','project','sprint')),
  scope_id       uuid,                          -- nullable for install-scope (singleton)
  hard_cap_usd   numeric(10,2) NOT NULL,
  soft_threshold_pct integer NOT NULL DEFAULT 80 CHECK (soft_threshold_pct BETWEEN 1 AND 100),
  on_soft        text        NOT NULL DEFAULT 'alert' CHECK (on_soft IN ('alert','pause','none')),
  on_hard        text        NOT NULL DEFAULT 'pause' CHECK (on_hard IN ('pause','kill','alert_only')),
  active         boolean     NOT NULL DEFAULT true,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cb_scope_idx ON cost_budgets (scope, scope_id);

CREATE TABLE IF NOT EXISTS cost_ledger (
  entry_id       uuid        PRIMARY KEY,
  occurred_at    timestamptz NOT NULL DEFAULT now(),
  project_id     uuid        NOT NULL,
  sprint_id      uuid,
  task_id        uuid,
  worker_id      uuid,
  persona_id     text,
  model          text        NOT NULL,         -- 'claude-sonnet-4-6' etc.
  provider       text        NOT NULL,
  input_tokens   integer     NOT NULL,
  output_tokens  integer     NOT NULL,
  cache_read_tokens integer  NOT NULL DEFAULT 0,
  cache_write_tokens integer NOT NULL DEFAULT 0,
  cost_usd       numeric(12,6) NOT NULL,        -- computed at write time using pricing.ts
  request_id     text                            -- provider-side id for traceability
);
CREATE INDEX IF NOT EXISTS cl_project_time_idx ON cost_ledger (project_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS cl_sprint_idx ON cost_ledger (sprint_id, occurred_at DESC);
CREATE INDEX IF NOT EXISTS cl_task_idx ON cost_ledger (task_id);
```

## Pricing table (`cost/pricing.ts`)
```ts
// Source of truth: keep in sync with public Anthropic pricing.
// Values are per million tokens, USD.
export const PRICING: Record<string, ModelPricing> = {
  'claude-opus-4-7':   { input: 15.00, output: 75.00, cacheRead: 1.50, cacheWrite: 18.75 },
  'claude-sonnet-4-6': { input:  3.00, output: 15.00, cacheRead: 0.30, cacheWrite:  3.75 },
  'claude-haiku-4-5':  { input:  1.00, output:  5.00, cacheRead: 0.10, cacheWrite:  1.25 },
}
```
Audit-comment with date and source URL. (Per CLAUDE.md "verify against current AWS docs" when stale.)

## Enforcement flow
```
scheduler.tick() before each spawn():
  → costEnforcer.canSpawn(projectId, sprintId, taskId, estimatedTokens)
    → SUM(cost_ledger) for the scope window (sprint window or project window)
    → if running_cost + estimated_cost > hard_cap → return {allow: false, action: 'pause'}
    → if running_cost + estimated_cost > soft_threshold → return {allow: true, warn: true}
    → else return {allow: true}
  → if !allow → emit BudgetExceeded + pauseController.pauseDueToCostCeiling(scope, scope_id, reason)

anthropic-driver.ts: after each request resolves:
  → cost.ledger.append({ ...usage, cost_usd: pricing.compute(usage) })
  → emit CostLedgerAppended
  → costEnforcer.checkLive(projectId, sprintId)
    → if running_cost > hard_cap → emit KillSwitchTripped → SIGTERM all workers in scope
```

## Kill switch
- `cost.killAll({scope, scope_id, reason})` mutation — capability-gated (admin only).
- Iterates `agent_workers` rows in scope, calls process.kill on each PID.
- Emits `KillSwitchTripped` per worker.
- Sets project/sprint status to `paused_cost`.

## Frontend UX

### Topbar (always visible — `components/TopBar.tsx`)
- Shows: "$X.XX / $Y.YY today" with progress bar.
- Color: green <50%, yellow 50–80%, red >80%, pulsing red >100%.
- Click → opens Cost page.

### `pages/Cost.tsx` (new)
- Top stats row:
  - Today: $X / $Y (% of daily cap)
  - Sprint: $X / $Y (% of sprint cap)
  - Project: $X / $Y (% of project cap)
  - Active workers: N (with kill-all button if budget exceeded)
- Live burn chart (last 1h, 24h, 7d):
  - Stacked-area by persona / model / sprint
- Per-task cost table:
  - Sortable: cost descending, recency, persona, model
  - Columns: task, persona, model, in_tokens, out_tokens, cost, started, finished
- Budget panel (right column):
  - Per-scope cards: Install / Project / Sprint
  - Edit budget (capability-gated)
  - Pick "on_soft" / "on_hard" actions
- Kill panel:
  - "Kill all workers in this scope" button (red, capability-gated, with confirmation modal)

### Sprint Plan summary card (extend existing component)
- Show forecasted cost vs cap for the sprint about to launch.
- Block "Launch sprint" CTA if forecast already exceeds cap.

### Settings → Budget tab (new)
- Set defaults for new projects/sprints.
- Toggle: "Auto-pause on hard cap" (default on).

## Acceptance criteria
1. `grep -rE "from '.*cost/(service|enforcer)'" packages/orchestrator/src/orchestration/scheduler.ts` returns ≥1 hit.
2. `grep -rE "from '.*cost/(service|enforcer)'" packages/orchestrator/src/personas/anthropic-driver.ts` returns ≥1 hit.
3. Integration test: set sprint hard_cap=$0.10 → run 3 fake-worker tasks each costing $0.05 → assert third task does NOT spawn (BudgetExceeded event written, scheduler returns no-spawn).
4. Live kill switch: 2 workers running → call `cost.killAll({scope: 'sprint', scope_id})` → both PIDs receive SIGTERM (verify via test harness).
5. UI: Cost page renders without runtime errors with fixture data; topbar shows live burn.
6. Pricing: model 'claude-sonnet-4-6' ledger entry with 1M input + 1M output tokens computes to $18.00 ($3 + $15) — unit test.
7. Cost is computed and persisted on every Anthropic call — `grep -E "cost\.ledger\.append" packages/orchestrator/src/personas/anthropic-driver.ts` ≥1.

## What "wired up" means
- Scheduler actually CALLS the enforcer before every spawn. Not just defined; actually invoked in scheduler.tick().
- AnthropicDriver actually writes ledger entries on every call. Not stubbed.
- Topbar visible widget shows live cost (subscribe to CostLedgerAppended events via WS).

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round6-05-cost-governance]`
