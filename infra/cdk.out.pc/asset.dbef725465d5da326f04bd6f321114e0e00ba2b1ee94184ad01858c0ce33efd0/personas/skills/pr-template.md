# Skill: PR description template

Every pull request must follow this structure. The reviewer reads this; the
audit trail consumes it; downstream agents parse it. Drift means broken
automation.

## Template

```
## Summary

<2-4 sentences describing what changed and why. Not the diff — the diff
already shows the what. Explain the why.>

## Acceptance criteria

- [ ] AC-1: <verbatim from the ticket> — verified by <test name or evidence>
- [ ] AC-2: ...
- [ ] AC-3: ...

## Evidence

- Tests added: <unit / integration / e2e>, count: N
- Manual verification: <commands you ran, screenshots if UI>
- Linked artifacts: <log file, smoke run output, etc.>

## Persona of record

<persona slug that authored this PR>
<task_id>
<sprint_id>
<capability_id used>

## Risk notes

- Blast radius: <which services / tables / users affected>
- Rollback: <revert this commit / migrate down / etc.>
- Open questions: <anything you punted on>

## Trace links

- Task: <orbital UI link>
- Sprint: <orbital UI link>
- Architecture: <ADR link if one was created>
```

## Rules

- Every AC checkbox must be ticked before requesting review. If one cannot be
  ticked, the PR is not ready — keep it as draft.
- Evidence is concrete: actual test names, actual commands, actual files.
- Persona of record is mandatory for agent-authored PRs. The capability_id
  links the PR to the bundle that authorized the work, which is the audit
  chain back to the ticket.
- Risk notes are required even for "no risk" changes — write "no risk"
  explicitly so a reviewer cannot mistake an omission for a blank.

## Atomicity

One PR = one logical change. Reviewer must be able to read the entire diff in
one sitting. If you exceed ~500 lines of meaningful diff (excluding generated
files), split the PR.

## Title

The title is a Conventional Commits header: `feat(orchestrator): real claude
worker spawn loop`. Same rules as a commit message: imperative, ≤ 72 chars,
no trailing period.

## In this codebase

The branch name follows `feat/<short-topic>` or `fix/<short-topic>`. Trunk-based
strategy: short-lived branches off `main`, rebased before merge. CI must be
green; review must be approved by a non-author persona.

After merge: the PR closes its tickets automatically (via the `Closes #N`
footer in the squash-merge commit) and the orchestrator records `PRMerged`
in the event store, which transitions the task to `done`.
