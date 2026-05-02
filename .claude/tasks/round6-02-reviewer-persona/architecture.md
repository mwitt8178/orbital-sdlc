# Round 6 — #2 Code-Review Persona + Agent-to-Agent Review Loop

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: M

## Why
Persona library at `packages/orchestrator/src/personas/library/` has 11 personas — architect, em, jr-dev, pm, principal-dev, qa, retro-analyst, scrum-master, security, sr-dev, verifier — and **no peer code reviewer**. Round 5C added an AC-level functional verifier (does the diff pass the spec?). The next gate is idiomatic/design/security review on the diff itself. Without it: single-shot writer + binary verifier, not a team.

## Depends on
Wave 2 (#1 PR loop) — reviewer reads from a real PR with a real diff.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `personas/library` | NEW `reviewer.ts` | Senior-reviewer persona definition: capability profile, system prompt, skills bundle |
| `personas/library/index.ts` | existing | Register new persona |
| `personas/skills/` | NEW `code-review-protocol.md` | The skill the reviewer loads — checklist + output format |
| `routing/engine.ts` | existing | Route `code-review` task type to reviewer persona; tier rules: cross-family vs author (if author was Sonnet, reviewer is Opus or Haiku — never same family per existing SoD rule) |
| `orchestration/scheduler.ts` | existing | New task type `code_review`; created on PROpened (#1 emits this) |
| `hooks` | NEW `packages/orchestrator/src/hooks/post-pr-opened.ts` | On PROpened event, create a child task with persona=reviewer, parent_task_id=author_task_id, ticket_id same as author |
| `github/pr-orchestrator.ts` | existing | New methods: `postReviewComment(pr, comment)`, `submitReview(pr, {state: APPROVED\|CHANGES_REQUESTED\|COMMENTED, body, comments[]})` |
| `db schema` | additive `code_reviews` table | Stores: review_id, pr_number, task_id, reviewer_persona_id, state, comments_count, posted_at |
| `events` | new types: `CodeReviewStarted`, `CodeReviewSubmitted` | aggregate_type='task', aggregate_id=author_task_id |
| `trpc` | NEW `code-reviews.ts` router | `code_reviews.byPR({pr_number})`, `code_reviews.requestRework({review_id})` (operator override) |
| `ui` | `pages/UAT.tsx` (existing) integrate; NEW `components/features/code-review/ReviewPanel.tsx` | Reviewer comments inline with diff |

## Reviewer capability profile (`personas/library/reviewer.ts`)
```ts
filesRead: ['**']                               // reads worktree + diff
filesWrite: []                                  // NEVER writes to worktree
boardRead: ['*']
boardMutate: []                                 // never touches board
channelRead: ['#review-*', '#orb-*']
channelPost: ['#review-*']
spawnSubagent: false
gitCommit: null
ghPRReview: ['<author_task_id>.pr_number']     // NEW capability: post review comments only on the specific PR
```

## Reviewer skill (`personas/skills/code-review-protocol.md`)
Checklist:
1. Read the diff via `gh pr diff <number>`
2. For each changed file, evaluate:
   - Idiom: does it follow project conventions (read CLAUDE.md, neighboring code)?
   - Security: hardcoded secrets, SQL injection, untrusted-input handling, DSQL hard-no list compliance
   - Tests: is new behaviour test-covered? are there missing edge cases?
   - DDD/multi-tenant: tenant_id flows correctly? aggregate boundaries respected?
   - Observability: structured logs with tenant_id? error handling explicit?
3. Decide: APPROVE | REQUEST_CHANGES | COMMENT
4. If REQUEST_CHANGES, post inline comments with file:line + suggested fix
5. Submit review via `gh pr review` (using ghPRReview capability)
6. Emit CodeReviewSubmitted

## Iteration flow
```
Author task done → PROpened (Wave 2 #1)
  → post-pr-opened hook
    → create child task: persona=reviewer, parent=author_task, type='code_review',
      description='Review PR #N', acceptance_criteria=['No CHANGES_REQUESTED state']
  → scheduler picks reviewer task
  → spawn reviewer with code-review-protocol skill
  → reviewer posts review
  → emit CodeReviewSubmitted

If state=CHANGES_REQUESTED:
  → post-review hook
    → reopen author task with state='ready', append to its description:
      '## Reviewer feedback\n<comments>'
    → scheduler re-spawns author worker
  → author iterates, force-pushes branch
  → reviewer task is re-created on next PROpened-equivalent (maybe new event PRSynchronized from webhook)

If state=APPROVED:
  → tasks.code_review_state = 'approved'
  → UI surfaces 'Ready to merge' on Backlog row
  → human merges (or autonomous merge if config allows; default OFF for v1)
```

## Frontend UX
### `ReviewPanel.tsx` (new) — mounted in PRDetailPanel "Reviews" tab
- Top: state badge (APPROVED green / CHANGES_REQUESTED red / COMMENTED gray)
- Reviewer identity: persona icon + name + model used
- Body: review summary
- Inline comments: file:line + comment, expandable to show surrounding 3 lines of diff
- Action buttons (operator):
  - "Override: mark approved" (capability-gated, logged)
  - "Request another reviewer" (creates a new code_review task)

### Backlog page
- Existing PRBadge gains a sub-state for review: `Open` / `Awaiting Review` / `Changes Requested` / `Approved` / `Merged`
- Sort/filter chip: "Awaiting review" / "Changes requested"

### UAT page
- Above ACChecklist, show: "Code review: APPROVED by reviewer-sonnet at 14:32" with link to ReviewPanel

## Acceptance criteria
1. `grep -E "reviewer" packages/orchestrator/src/personas/library/index.ts` returns a registration line.
2. `grep -E "post-pr-opened|onPROpened" packages/orchestrator/src/hooks/` returns ≥1 hit.
3. Integration test: simulate PROpened event → reviewer task created → spawn (fake-worker mode) → reviewer posts review (via fixture HTTP) → CodeReviewSubmitted event recorded → tasks.code_review_state populated.
4. Cross-family rule: when author persona used Opus, routing engine MUST NOT route reviewer to Opus. Test this with a parameterized routing test.
5. UI: ReviewPanel imported into PRDetailPanel; renders CHANGES_REQUESTED + APPROVED states correctly.
6. End-to-end: an APPROVED review on a fixture PR causes tasks.code_review_state='approved' AND a UI affordance "Ready to merge" appears on Backlog.

## What "wired up" means
- post-pr-opened hook is registered in `hooks/registry-bootstrap.ts` or equivalent — not just defined.
- Reviewer persona is in `loader.ts` listing — `getPersonas()` returns it.
- Scheduler treats `task_type='code_review'` as feasible.

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round6-02-reviewer-persona]`
