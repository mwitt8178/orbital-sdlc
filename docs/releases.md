# Orbital Release Pipeline

This document is the source of truth for how code reaches the `mwitt` environment
and (eventually) `prod`. **No ad-hoc agent or human deploys.** All staging and
production deploys flow through GitHub Actions using OIDC-assumed AWS roles.

---

## Branch model — trunk-based

```
main                          production-ready, always deployable, protected
 ^                            (no direct push; only fast-forward from release/mwitt)
 |   release-promotion PR
 |
release/mwitt                 staging branch tracking mwitt env
 ^                            (auto-deploys to mwitt on push)
 |   feature PR (squash or --no-ff merge)
 |
feat/*  fix/*  chore/*        short-lived feature branches
```

### Naming rules

| Prefix      | Use                                             | Example                          |
|-------------|-------------------------------------------------|----------------------------------|
| `feat/`     | New user-visible feature or new internal capability | `feat/settings-billing`     |
| `fix/`      | Bug fix on a released feature                   | `fix/multi-project-isolation`    |
| `chore/`    | Non-functional changes (deps, tooling, docs)    | `chore/upgrade-vite-5`           |
| `release/<env>` | Per-env release trains                      | `release/mwitt`                  |

Rules:

- All feature branches branch **from `release/mwitt`** (not from `main`).
- Branches are short-lived (target: < 5 days). Long-running branches must rebase
  onto `release/mwitt` daily.
- Branch names use lowercase-kebab. Worktree directories follow the convention
  `../orbital-<branch-tail>`.
- A branch is checked out in **at most one worktree** at a time.

### PR flow

1. `feat/X -> release/mwitt`
   - Conventional commit title (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`,
     `test:`).
   - PR body explains *what* and *why*.
   - `pr-check.yml` is a required check. Must be green.
   - At least one reviewer approval (cross-family if Engineer-Principal authored).
   - Merge with `--no-ff` to preserve the feature topology in history. Squash is
     allowed for trivially small PRs (< 50 LoC).

2. `release/mwitt -> main` (release-promotion PR)
   - Opens after a successful staging soak (default: 24h with no failed
     `walk-deep.mjs` run on the `release/mwitt` tag train).
   - PR title: `release: mwitt-v<ts> -> main`.
   - Required checks: latest `mwitt-v*` tag exists and was a successful deploy
     (verified by workflow guard).
   - Merge by **fast-forward only**. If `main` has diverged from `release/mwitt`
     (it shouldn't, but if it has — e.g. a hotfix PR'd directly into `main`),
     `release/mwitt` must be rebased onto `main` first.

3. Hotfix flow (rare, breaking-prod only)
   - `fix/hot-X` branched from `main`.
   - PR'd into both `main` and `release/mwitt` simultaneously (cherry-pick).
   - Same `pr-check.yml` gates apply.

### Migration policy

**Migrations are applied via the release pipeline only. Never via an agent's
direct Lambda invoke or a developer's workstation.**

Concretely:

- All migration SQL files live in `packages/db/src/migrations/` with a strict
  `NNNN_<slug>.sql` naming convention.
- The journal `packages/db/src/migrations/meta/_journal.json` is the source of
  truth for ordering. `idx` values must be monotonic and contiguous.
- When merging a feature branch into `release/mwitt` that introduces a new
  migration, the migration is **renumbered** to the next available `idx` using
  `scripts/renumber-migrations.mjs` before the PR can be merged. The
  `pr-check.yml` workflow validates the journal is monotonic and that no
  migration `idx` collides with the live state.
- The migration-runner Lambda (`orbital-mwitt-migration-runner`) is invoked by
  `migrations.yml` on every push to `release/mwitt` whose diff touches
  `packages/db/src/migrations/**`. App deploy waits for migration success.
- Live state at the time of pipeline cutover (2026-05-04): journal idx 0..43,
  ending at `0044_tenant_credentials`, `0045_cost_budgets_monthly`,
  `0046_projects_color_deleted`, `0047_project_personas`. New integrations
  start at `idx 47` -> migration `0048_*` and renumber from there.

### Rollback strategy

Every successful `deploy-mwitt.yml` run creates an annotated git tag
`mwitt-v<YYYYmmdd-HHMMSS>` containing the deployed Lambda version, UI artifact
ETag, CloudFront distribution ID, and git SHA. The full tag annotation looks
like:

```
deploy: mwitt-v20260504-143012

lambda_function=orbital-mwitt-api
lambda_version=42
lambda_alias_live_was_pointing_at=41
ui_s3_etag="abc123..."
cloudfront_distribution=E28L1XYTKZTJQG
git_sha=9076368...
walk_deep_passes=20
walk_deep_total=20
walk_settings_passes=6/6
```

To roll back:

```
gh workflow run deploy-mwitt.yml \
  -f rollback_to=mwitt-v20260504-143012
```

The workflow's rollback path skips build + UI sync, instead:

1. Reads `lambda_version` from the target tag annotation.
2. `aws lambda update-alias --function-name orbital-mwitt-api --name live --function-version <N>`.
3. Restores UI by S3-syncing the artifact captured at that tag (every deploy
   stores `ui-dist-<tag>.tar.gz` in the deploy-artifacts bucket; rollback
   downloads + extracts + syncs).
4. CloudFront invalidate `/*`.
5. Verifies: walk-deep + walk-settings.
6. Tags `mwitt-v<new-ts>` with `rollback_of=mwitt-v<previous>` annotation so
   forward history reflects the rollback.

Migrations are **never auto-rolled-back**. If a migration is destructive and
the deploy fails downstream, that's a forward-fix scenario — open an
incident and write `00NN_revert_<slug>.sql`.

---

## CI/CD workflows

| Workflow             | Trigger                                                            | Purpose                                                          |
|----------------------|--------------------------------------------------------------------|------------------------------------------------------------------|
| `pr-check.yml`       | PR opened/updated targeting `release/mwitt` or `main`              | install + lint + typecheck + test + build + journal monotonicity |
| `migrations.yml`     | push to `release/mwitt` with `packages/db/src/migrations/**` diff  | invoke migration-runner Lambda; gates app deploy                 |
| `deploy-mwitt.yml`   | push to `release/mwitt` (after `migrations.yml` if applicable)     | build api zip -> publish version -> flip alias -> S3 -> CF -> verify -> tag |

### Superseded workflows

The following workflows are **deprecated** as of 2026-05-04. They remain in
the repo for now to avoid breaking any external automation that calls them;
they will be removed once the release/mwitt pipeline has a clean week of runs.

- `deploy.yml` — replaced by `deploy-mwitt.yml`. Old workflow used CDK deploy
  on every push and conflated infra changes with app deploys.
- `ui-deploy.yml` — replaced by `deploy-mwitt.yml`'s UI step.
- `post-deploy-smoke.yml` — replaced by the `walk-deep` + `walk-settings`
  steps inside `deploy-mwitt.yml`.

`hub-image.yml` (daemon image build) and `ci.yml` (legacy CI) are retained.

---

## OIDC role + secrets

### Role: `OrbitalGitHubDeployRole-mwitt`

ARN: `arn:aws:iam::<account>:role/OrbitalGitHubDeployRole-mwitt`
(filled in after first CDK deploy of `infra/lib/github-oidc-role.ts`).

Trust policy condition:

```json
"StringEquals": {
  "token.actions.githubusercontent.com:aud": "sts.amazonaws.com"
},
"StringLike": {
  "token.actions.githubusercontent.com:sub": [
    "repo:mwitt8178/orbital-sdlc:ref:refs/heads/release/mwitt",
    "repo:mwitt8178/orbital-sdlc:environment:mwitt",
    "repo:mwitt8178/orbital-sdlc:pull_request"
  ]
}
```

Permissions (explicit, minimal):

- `lambda:UpdateFunctionCode`, `lambda:PublishVersion`, `lambda:UpdateAlias`,
  `lambda:GetFunction`, `lambda:GetAlias`, `lambda:ListVersionsByFunction`
  on `arn:aws:lambda:us-east-1:<account>:function:orbital-mwitt-api` and
  `arn:aws:lambda:us-east-1:<account>:function:orbital-mwitt-api:*`.
- `lambda:InvokeFunction` on
  `arn:aws:lambda:us-east-1:<account>:function:orbital-mwitt-migration-runner`.
- `s3:PutObject`, `s3:DeleteObject`, `s3:GetObject`, `s3:ListBucket` on
  `arn:aws:s3:::orbital-ui-mwitt-<account>` and `arn:aws:s3:::orbital-ui-mwitt-<account>/*`.
- `cloudfront:CreateInvalidation`, `cloudfront:GetInvalidation` on
  `arn:aws:cloudfront::<account>:distribution/E28L1XYTKZTJQG`.
- `sts:GetCallerIdentity`.

CDK source: `infra/lib/github-oidc-role.ts` (added in this PR).

### GitHub Actions secrets (per repo or per environment `mwitt`)

| Secret                       | Description                                                          |
|------------------------------|----------------------------------------------------------------------|
| `AWS_ROLE_ARN`               | ARN of `OrbitalGitHubDeployRole-mwitt`                              |
| `AWS_ACCOUNT_ID`             | 12-digit AWS account ID                                              |
| `CLOUDFRONT_DISTRIBUTION_ID` | `E28L1XYTKZTJQG`                                                     |
| `S3_BUCKET`                  | `orbital-ui-mwitt-<account>`                                         |
| `LAMBDA_FUNCTION_NAME`       | `orbital-mwitt-api`                                                  |
| `MIGRATION_LAMBDA_NAME`      | `orbital-mwitt-migration-runner`                                     |
| `WALK_DEEP_BASE_URL`         | `https://d2mtgpa71y9c8t.cloudfront.net` (or custom domain when live) |
| `WALK_DEEP_USER` / `WALK_DEEP_PASS` | Credentials for the post-deploy walk login (test tenant)      |
| `ANTHROPIC_API_KEY`          | (optional) for daemon E2E tests; not used by deploy itself           |

GitHub *variables* (non-secret):

| Variable           | Description                                |
|--------------------|--------------------------------------------|
| `AWS_REGION`       | `us-east-1`                                |
| `ORBITAL_DOMAIN`   | `mwitt.orbital.team.dev`                   |

---

## Hardening — TODO (out of scope for the cutover PR)

- [ ] Add an SCP / IAM deny on humans for `lambda:UpdateFunctionCode` on
      `orbital-mwitt-api`. Only `OrbitalGitHubDeployRole-mwitt` may mutate it.
- [ ] Add a GitHub branch protection ruleset on `release/mwitt` requiring
      `pr-check.yml` passing + 1 review + linear history + signed commits.
- [ ] Add `main` branch protection: only fast-forward, only from `release/mwitt`,
      required reviewers from the principals team.
- [ ] Wire `walk-deep` + `walk-settings` results into a CloudWatch metric so we
      can alarm on regressions.
- [ ] Decommission `deploy.yml` / `ui-deploy.yml` / `post-deploy-smoke.yml`
      after a week of clean runs on the new pipeline.
