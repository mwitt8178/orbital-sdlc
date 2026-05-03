# Code Review Protocol

**Skill slug:** `code-review-protocol`
**Required by:** reviewer persona

---

## Overview

This skill teaches the reviewer persona how to perform structured peer code review on a GitHub PR diff. The output is a GitHub PR review (APPROVED, CHANGES_REQUESTED, or COMMENTED).

---

## Pre-review checklist

Before evaluating the diff, load context:

1. `gh pr view <number>` — read the PR description (what was the task? what changed?)
2. `gh pr diff <number>` — read the full diff
3. Read `CLAUDE.md` (or equivalent project conventions file) — this is the contract you enforce
4. Skim 2-3 neighboring files in the changed paths — understand the established idiom

---

## Evaluation checklist (per changed file)

### 1. Idiom and conventions

- [ ] Follows naming conventions from CLAUDE.md?
- [ ] Functions are focused (do one thing)?
- [ ] No premature abstractions (two use-cases before extraction)?
- [ ] No dead code, commented-out blocks, or stale TODOs?
- [ ] Imports grouped correctly (external → internal → relative)?
- [ ] Error handling is explicit, not swallowed?

### 2. Security

- [ ] No hardcoded secrets, tokens, or API keys?
- [ ] No SQL injection (parameterized queries only)?
- [ ] User input validated before it touches DB or business logic?
- [ ] Auth/authz checks present on all protected routes/procedures?
- [ ] **DSQL hard-no list:**
  - No foreign keys, triggers, sequences/SERIAL, materialized views, stored procs, extensions
  - OCC retry helper called on every mutating transaction
  - Transactions < 5 min, < ~10k rows mutated
  - DDL separate from DML (never same transaction)
  - IDs are UUIDv7/ULID generated in app, not sequences
  - `CURRENT_TIMESTAMP` vs `clock_timestamp()` used correctly

### 3. Tests

- [ ] New public behaviour has at least one test?
- [ ] Edge cases covered: empty input, null/undefined, concurrent calls, error paths?
- [ ] Tests are isolated (no shared mutable state between test cases)?
- [ ] No mocks in `src/` — test fixtures belong in `tests/` or `__fixtures__/`?
- [ ] `go test ./...` or `vitest run` would pass with this diff?

### 4. DDD / multi-tenant isolation

- [ ] `tenant_id` passed explicitly to every repo/handler method?
- [ ] Every DB query includes a tenant scope predicate?
- [ ] Events include `tenant_id` in payload?
- [ ] Aggregate boundaries respected (no cross-aggregate direct DB reads)?

### 5. Observability

- [ ] Structured logging on every code path (not `console.log`)?
- [ ] Log context includes `tenant_id`, `task_id`, relevant IDs?
- [ ] No PII, passwords, or tokens logged?
- [ ] Errors: full stack trace on server, safe message to client?

---

## Verdict decision rules

| Condition | Verdict |
|-----------|---------|
| All checklist items pass | **APPROVED** |
| Any security issue (hardcoded secret, SQL injection, missing auth, DSQL violation) | **CHANGES_REQUESTED** |
| Missing tests for new observable behaviour | **CHANGES_REQUESTED** |
| Correctness bug (logic error, wrong return value, race condition) | **CHANGES_REQUESTED** |
| Style / naming nit (non-blocking) | **COMMENTED** (note in review body, don't block) |
| Question about intent (may be intentional) | **COMMENTED** |

**Never approve code with security issues or missing tests for new behaviour.**

---

## Output format

### APPROVED

```
gh pr review <number> --approve --body "Looks good. <brief 1-2 sentence summary of what was reviewed>"
```

### CHANGES_REQUESTED

```
gh pr review <number> --request-changes --body "$(cat <<'EOF'
## Summary
<1-3 sentence summary of the overall review>

## Blocking issues

<For each issue:>
### <file.ext>:<line> — <short title>
<What is wrong>
<Suggested fix (code snippet when helpful)>
EOF
)"
```

For inline file comments (preferred for file:line issues):

```
gh pr review <number> --request-changes \
  --comment "packages/foo/bar.ts:42: The OCC retry helper is not called here. Wrap the insert in withOCCRetry()." \
  --body "Blocking: OCC retry missing on mutating transaction."
```

### COMMENTED

```
gh pr review <number> --comment --body "<comment text>"
```

---

## After submitting

Emit completion (the post-review hook fires on your task completion and creates the CodeReviewSubmitted event). Do not manually emit events.

If state=CHANGES_REQUESTED, the post-review hook will:
1. Reopen the author task with your feedback appended to its description
2. Re-queue the author for a new spawn cycle

If state=APPROVED, the post-review hook will:
1. Set tasks.code_review_state = 'approved' on the author task
2. The UI will show "Ready to merge" on the Backlog row

---

## What you do NOT do

- Do not write code or modify any file in the worktree
- Do not commit, push, or merge
- Do not post to #general, #orb-*, or any channel other than #review-*
- Do not touch the Monday board
- Do not invent acceptance criteria — evaluate only against existing CLAUDE.md conventions and the PR description
