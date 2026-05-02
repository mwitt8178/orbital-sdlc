# Round 6 — #6 CI/CD Bridge — Verifier Evidence From Real CI

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: M

## Why
Round 5C's verifier spawns the test framework inside the worktree (good first cut). The canonical green/red signal in any real org is the CI pipeline on a clean checkout. Once #1 (PR loop) is in, the verifier should treat GitHub Actions output as primary evidence: subscribe to `check_run` webhooks, attach the run URL to `ac_check_evidence`, fail-closed if CI is red. Without this, "passes locally" is the only proof — and that's how prod incidents start.

## Depends on
Wave 2 (#1 PR loop) — needs PRs to exist and webhook receiver registered.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `github/webhook.ts` | existing (after #1 wired it) | New event handlers: `check_run`, `check_suite`, `workflow_run` |
| `verifiers/ac-checker.ts` | existing (Round 5C) | New mode: `ci_run` evidence kind. When PR exists and CI has run, prefer CI evidence over local spawn |
| `verifiers/evidence.ts` | existing | Extend `recordEvidence` to accept `evidence_kind='ci_run'` with `ci_run_url`, `ci_check_name`, `ci_conclusion` |
| `db schema` | existing `audit.ac_check_evidence` table — add columns `ci_run_url text`, `ci_check_name text`, `ci_conclusion text` (additive migration `0025_ci_evidence.sql`) | |
| `events` | new types: `CIRunStarted`, `CIRunCompleted`, `CIRunFailed` | aggregate=task |
| `verifiers/service.ts` | existing | New: `awaitCI(taskId, pr_number, timeout)` — subscribe to CIRunCompleted before declaring AC pass |
| `trpc` | existing `uat` router | Extend `uat.ac.evidence` to surface CI run URL + conclusion |
| `ui` | `components/features/uat/ACChecklist.tsx`, `EvidencePanel.tsx`, `PRDetailPanel.tsx` "CI" tab | Show CI badges + run URLs |

## Schema diff (`0025_ci_evidence.sql`)
```sql
ALTER TABLE audit.ac_check_evidence
  ADD COLUMN IF NOT EXISTS ci_run_url     text,
  ADD COLUMN IF NOT EXISTS ci_check_name  text,
  ADD COLUMN IF NOT EXISTS ci_conclusion  text CHECK (ci_conclusion IS NULL OR ci_conclusion IN ('success','failure','cancelled','skipped','timed_out','neutral'));

ALTER TABLE audit.ac_check_evidence
  DROP CONSTRAINT IF EXISTS ac_check_evidence_evidence_kind_check;

ALTER TABLE audit.ac_check_evidence
  ADD CONSTRAINT ac_check_evidence_evidence_kind_check
  CHECK (evidence_kind IN ('test_run','static_analysis','llm_inspection','manual_required','ci_run'));
```

## Evidence-kind precedence
When the verifier spawns for an AC and a PR with CI runs exists:
1. Prefer `ci_run` evidence: read all CI check_runs on the head SHA. If any check_run with name matching the AC keyword (e.g. "test", "lint", "build") has `conclusion=success` → record as `ci_run` evidence with that run URL.
2. If CI is failing or pending → wait up to N minutes (configurable, default 10 min) for CI to settle, OR fall back to local `test_run` evidence if CI never runs (e.g. webhook delivery is broken).
3. If both CI and local agree on pass → both evidences recorded; primary=ci_run.
4. If CI fails but local passes → record `result=fail` with `evidence_kind=ci_run`; surface mismatch warning to operator.

## Webhook event flow
```
GitHub: workflow_run.completed → POST /webhook/github
  → github/webhook.ts handler
    → emit CIRunCompleted(aggregate=task lookup by head_sha → tasks.head_sha matches)
    → for each pending verifier task awaiting this CI run:
      → mark `awaitingCI` resolved
      → verifier worker proceeds with CI-evidence path
```

## Frontend UX

### `ACChecklist.tsx` (extend existing)
- Per-AC row: status icon (✓/✗/?/—) gains a sub-icon for evidence source:
  - 🔬 = local test run
  - ☁️ = CI run (with link to GH Actions page)
  - 👁 = LLM inspection
- Hover → tooltip "CI: success (run #12345 · 2m12s)"
- Click → expand EvidencePanel with full details

### `EvidencePanel.tsx` (extend)
- New section: "CI Run"
  - check_name, conclusion badge, duration, link to GitHub Actions
  - Embedded iframe-or-link to the run logs (external — no scraping)

### PRDetailPanel "CI" tab (filled in this wave)
- List all check_runs for the head SHA
- Per row: name, conclusion, duration, started_at, completed_at, link to GitHub
- Aggregate: "12/13 checks passing" with the failing one highlighted
- "Re-run failed checks" button (calls GH API; capability-gated)

### Topbar / Backlog row
- PRBadge gets a CI sub-badge: green check / red x / yellow dot (running) / gray (no CI)

## Webhook security
- Validate HMAC signature (`X-Hub-Signature-256`) using `GITHUB_WEBHOOK_SECRET`.
- Reject with 401 if invalid; log but do NOT reveal which check failed (timing-attack hardening).
- Idempotency: GH may redeliver — dedupe by `delivery_id` header in `ci_runs_seen` table or memo-set with TTL.

## Acceptance criteria
1. `grep -E "check_run|workflow_run" packages/orchestrator/src/github/webhook.ts` returns ≥2 hits.
2. Migration 0025 applies cleanly; `ci_run` evidence_kind is accepted.
3. Integration test: simulate `check_run.completed` webhook with success conclusion → assert CIRunCompleted event written → assert ac_check_evidence has matching ci_run_url + conclusion.
4. CI-fail-blocks-pass test: simulate CI failure → AC verifier records result=fail with evidence_kind=ci_run.
5. Mismatch test: local pass + CI fail → record fail, emit warning event.
6. UI: ACChecklist row shows ☁️ icon when evidence_kind=ci_run; EvidencePanel CI section renders.
7. HMAC: invalid signature returns 401 — unit test.

## What "wired up" means
- Webhook handler IS registered (Fastify route `/webhook/github` accepts the events).
- Verifier IS using CI evidence when present — `grep -E "ci_run" packages/orchestrator/src/verifiers/ac-checker.ts` ≥1.
- UI imports the new icons and renders them — `grep "ci_run" packages/ui/src/components/features/uat/` ≥1.

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round6-06-ci-bridge]`
