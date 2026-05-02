# Skill: Commit message conventions

This codebase uses [Conventional Commits](https://www.conventionalcommits.org).
Every commit message must match the spec.

## Format

```
<type>(<scope>): <imperative summary>

<optional body>

<optional footer>
```

## Types

- `feat` — a new feature visible to a user
- `fix` — a bug fix
- `refactor` — code change that does not alter behavior
- `chore` — routine maintenance: dependency bumps, formatting, build config
- `docs` — documentation only
- `test` — tests only
- `perf` — performance-only improvement
- `ci` — CI configuration

## Rules

- The summary is **imperative mood**: "add", "fix", "update". Not "added",
  "fixed", "updates".
- The summary is **lowercase**, no trailing period, ≤ 72 characters.
- A scope is optional but encouraged for monorepos: `feat(orchestrator): ...`,
  `fix(ui): ...`.
- Bodies are wrapped at 72 columns and explain the **why**, not the **what**
  (the diff already shows the what).
- Footers reference issues: `Closes #123`, `Refs #456`.

## Examples

```
feat(auth): add password reset flow
fix(scheduler): retry on serialization_failure
refactor(events): extract notify client into separate module
chore: bump drizzle-orm to 0.36.1
docs(readme): document worktree setup
test(spawn): cover ENOENT path for missing claude binary
```

## Atomicity

One logical change per commit. If you find yourself writing "and" in a commit
message, split the commit. The exception: small, related touch-ups in the
same scope (e.g., a method rename plus its usages).

## What never to commit

- WIP commits to a shared branch — squash them locally first
- Commented-out code, debug prints, "TEMP:" notes
- Credentials, .env files, large binaries
- Generated files unless explicitly tracked

## In this codebase

The pre-commit hook formats and lints. If a hook fails, the commit did not
happen — fix the issue and create a new commit (do not amend an unrelated
commit).
