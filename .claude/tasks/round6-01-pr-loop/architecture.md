# Round 6 — #1 GitHub PR Loop Wired Into Spawn Cycle

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: L

## Why
`packages/orchestrator/src/github/` exists (5 files: client.ts, pr-orchestrator.ts, pr-body-builder.ts, webhook.ts, types.ts) and migration `0021_audit_export...` already added PR-linkage columns on tasks. **`grep -rE "from '.*github" packages/orchestrator/src/ | grep -v "/github/"` returns ZERO hits.** It's dead code. The product's promise — "describe → build → ship" — does not actually ship today.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `github` (existing, dead) | `client.ts`, `pr-orchestrator.ts`, `pr-body-builder.ts`, `webhook.ts` | Wire into post-task hook; extend pr-orchestrator with branch-push step |
| `hooks` | `packages/orchestrator/src/hooks/post-task.ts` | After verifier passes, push worktree branch + open PR via PROrchestrator |
| `orchestration` | `packages/orchestrator/src/orchestration/spawn.ts`, `worktree.ts` | Worker creates branch `agent/<task-id>` on spawn; post-task pushes |
| `db schema` | additive `tasks.pr_number`, `tasks.pr_url`, `tasks.pr_merged_at` columns already exist (migration 0022) | none |
| `events` | `packages/orchestrator/src/events/types.ts` | New event types: `BranchPushed`, `PROpened`, `PRMerged`, `PRClosed` |
| `trpc` | `packages/orchestrator/src/trpc/routers/tasks.ts` (or new `prs.ts`) | Query: `tasks.getPR({task_id})` returns latest PR state; webhook receiver `prs.webhook` |
| `webhook receiver` | `packages/orchestrator/src/middleware/webhook.ts` (new or extend) | Public route `/webhook/github` validates HMAC, dispatches to `github/webhook.ts` handler |
| `ui` | `packages/ui/src/pages/Backlog.tsx`, `pages/UAT.tsx`, `components/features/uat/ACChecklist.tsx`, NEW `components/features/pr/PRBadge.tsx`, NEW `components/features/pr/PRDetailPanel.tsx` | Visible PR state at every stage |

## Required env / config
- `GITHUB_TOKEN` — already in `.env.example`? add if missing. Per-install setting in onboarding.
- `GITHUB_OWNER`, `GITHUB_REPO` — per-project setting (NEW columns on `projects` table OR `~/.orbital/config/install.json`).
- Webhook secret: `GITHUB_WEBHOOK_SECRET` — required for HMAC verification, fail-closed if absent.

## Event flow
```
TaskCompleted (existing event, after verifier PASS)
  → post-task hook (already exists for verifier spawn — extend it)
    → if task.persona NOT in {verifier} (i.e. real worker, not the verification spawn itself):
      → load worktree path from agent_workers
      → cd worktree && git add -A && git commit -m "feat(<ticket-id>): <task title>"
      → git push origin agent/<task-id>
      → emit BranchPushed
      → PROrchestrator.openPR({owner, repo, base: 'main', head: 'agent/<task-id>',
                              title: ticket.title, body: prBodyBuilder(task, verification, evidence)})
      → write tasks.pr_number / tasks.pr_url / tasks.pr_opened_at
      → emit PROpened (aggregate=task, payload={pr_number, pr_url, head_sha})

GitHub webhook → /webhook/github (HMAC-verified)
  → github/webhook.ts handler dispatches by event type
    → pull_request.closed + merged → emit PRMerged → set tasks.pr_merged_at
    → pull_request.closed (not merged) → emit PRClosed
    → pull_request_review.submitted → emit PRReviewSubmitted (carries reviewer + state)
    → check_run.completed → emit CIRunCompleted (Wave 3 #6 will consume this)
```

## DSQL/schema diff
Already covered by migration 0022. Verify columns are still present and add a `tasks.head_sha text` if missing (needed to re-run CI on the same SHA).

## Frontend UX (REQUIRED — must ship in same task)

### Backlog page (`packages/ui/src/pages/Backlog.tsx`)
- Each task row gains a `<PRBadge taskId={task.id} />` cell.
- Badge states: `—` (no PR), `Open` (yellow), `Approved` (blue), `Merged` (green), `Closed` (gray), `Conflicts` (red).
- Hover → tooltip with PR number, branch name, last-updated time. Click → opens PRDetailPanel as right-side drawer.

### UAT page (`packages/ui/src/pages/UAT.tsx`)
- Above ACChecklist, add a `<PRSummaryStrip>` showing: PR title, branch, status badge, "Open in GitHub" external link, head SHA (short).
- ACChecklist evidence rows already show test_command/test_output. Add a "Source: PR #123 commit abc1234" footer per row when evidence is from a CI run vs local.

### PRDetailPanel (NEW — drawer, mounted in app shell)
- Header: PR title, status badge, "Open in GitHub" external link
- Tabs: Overview / Diff Summary / Reviews / CI / Activity Timeline
- Overview: branch, base, head SHA, opened-by-agent, opened_at, last-update
- Diff Summary: file count, +/- lines (read from GitHub API), top 5 changed files
- Reviews: each reviewer (human or agent), state, submitted_at, comment count
- CI: list of check_runs (will be populated by #6 in Wave 3 — leave the section but show "—" until then)
- Activity Timeline: events from event store filtered by `aggregate_id=task_id` and event_type IN PR-related types

### Admin → Settings → "GitHub" tab (NEW — `packages/ui/src/components/features/settings/GitHubTab.tsx`)
- Per-project: connect/disconnect, owner, repo, default branch
- Webhook URL display + "Copy webhook secret" affordance
- "Test connection" button (calls `prs.testConnection`)
- Status: token validity, webhook last received

## Acceptance criteria (verify with grep + integration test, NO MOCKS)
1. `grep -rE "from '.*github/(client|pr-orchestrator|webhook)'" packages/orchestrator/src/ | grep -v "/github/"` returns ≥3 matches outside the `github/` directory.
2. `grep -rE "BranchPushed|PROpened|PRMerged" packages/orchestrator/src/events/types.ts` returns 4 hits.
3. Integration test (real Postgres, mocked GitHub at the `client.ts` HTTP boundary ONLY — fixture HTTP responses, NOT method-level mocks):
   - spawn a fake-worker task → mark TaskCompleted → assert BranchPushed event written, PROpened event written, tasks.pr_url populated
   - simulate webhook POST with merged payload → assert PRMerged event + tasks.pr_merged_at populated
4. UI test (Vitest + React Testing Library):
   - Backlog renders PRBadge per task with correct status
   - PRDetailPanel renders without runtime errors when given a fixture PR
5. Manual smoke (operator-doable): create a real GitHub repo, set token, run a sprint, observe a PR appears.

## What "wired up" means (NOT optional)
- Post-task hook calls PROrchestrator. **No facade.** No "TODO: actually push" comment.
- Webhook route registered on Fastify, HMAC-verified, dead-letters with structured log on bad signature.
- Backlog page imports and renders `<PRBadge>`. **`grep "PRBadge" packages/ui/src/pages/Backlog.tsx` returns ≥1 hit.**
- PRDetailPanel routed from app shell, opened from Backlog click.

## Out of scope (deferred to other waves)
- CI green/red gating → #6 Wave 3
- Code review on PRs → #2 Wave 5
- Defect-driven re-spawn from PR review comments → #3 Wave 5

## Rollback
1. Migration 0022 already shipped — additive, no rollback needed
2. Feature flag: `ORBITAL_PR_LOOP=on|off` in env, default `off`. When `off`, post-task hook short-circuits before the push step. When `on`, full path runs.

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round6-01-pr-loop]`
