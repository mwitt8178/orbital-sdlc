# Orbital Branch Management + Release Pipeline

**Run:** orbital-pipeline-2026-05-04
**Persona:** Engineer-Principal (Opus)
**Risk tier:** High (CI/CD wiring, IAM, migration policy, multi-branch integration)
**Estimate:** XL (~1 week of focused engineering condensed into a multi-turn execution)

## Bounded contexts touched

- **Release engineering** (new) — branch model, GitHub Actions, OIDC role
- **Migration runner** — policy: migrations only via release pipeline, never via ad-hoc agent
  Lambda invoke. Renumber tooling enforces monotonic journal.
- **Multi-tenant DB (DSQL/Aurora-compat)** — migration ordering only; no schema change here.
- **API Lambda + UI + CloudFront** — deploy choreography unified into one workflow.
- **Settings router** (UI) — 6-way merge integration target.

## Aggregate boundaries

No new aggregates. Migration journal (`_journal.json`) is the linearisable artifact;
serialisation is enforced by the renumber tool + `release/mwitt` being the single
mainline that the deploy pipeline reads.

## Event flow

1. Developer opens PR `feat/* -> release/mwitt`.
2. `pr-check.yml` runs install+lint+typecheck+test+build. Required check.
3. On merge to `release/mwitt`:
   a. `migrations.yml` fires if `packages/db/src/migrations/**` changed; invokes
      `orbital-mwitt-migration-runner` Lambda. Must succeed before app deploy.
   b. `deploy-mwitt.yml` fires: build -> publish lambda zip -> `lambda:UpdateFunctionCode`
      on `orbital-mwitt-api` -> `lambda:PublishVersion` -> `lambda:UpdateAlias` flips
      `:live` to new version -> S3 sync UI dist -> CloudFront invalidate `/*` -> wait ->
      `node packages/ui/walk-deep.mjs` -> on success, tag `mwitt-v$(date +%Y%m%d-%H%M%S)`.
4. Promotion `release/mwitt -> main` is a separate PR; `main` is protected and only
   accepts merges from `release/mwitt` after a clean staging soak.

## IAM diff

New role: `OrbitalGitHubDeployRole-mwitt`. Trust: GitHub OIDC, `sub` constrained to
`repo:mwitt8178/orbital-sdlc:ref:refs/heads/release/mwitt` plus
`repo:mwitt8178/orbital-sdlc:environment:mwitt`.

Minimal policy (explicit, no wildcards on resource where avoidable):

- `lambda:UpdateFunctionCode`, `lambda:PublishVersion`, `lambda:UpdateAlias`,
  `lambda:GetFunction`, `lambda:GetAlias` on
  `arn:aws:lambda:us-east-1:<account>:function:orbital-mwitt-api`
  and `:orbital-mwitt-api:*`.
- `lambda:InvokeFunction` on
  `arn:aws:lambda:us-east-1:<account>:function:orbital-mwitt-migration-runner`.
- `s3:PutObject`, `s3:DeleteObject`, `s3:ListBucket`, `s3:GetObject` on
  `arn:aws:s3:::orbital-ui-mwitt-<account>` and `/*`.
- `cloudfront:CreateInvalidation`, `cloudfront:GetInvalidation` on
  `arn:aws:cloudfront::<account>:distribution/E28L1XYTKZTJQG`.
- `sts:GetCallerIdentity` (no resource).

Does NOT include: cdk deploy permissions, IAM mutation, KMS key admin, RDS proxy
admin, ECR push (those remain on the existing infra-deploy role used by
`deploy.yml`/`hub-image.yml`).

## DSQL / Aurora schema diff

None in this PR. Pipeline only changes how migrations are applied
(release-pipeline-only). Existing 0001..0047 unchanged on the live DB. New
migrations introduced by integrated branches are renumbered to start at 0048
in deterministic merge order.

## Blast radius

- `release/mwitt` push that fails `migrations.yml`: blocks app deploy. UI is
  on previous good tag. **Rollback:** none needed — failed migration aborts
  before app code change.
- `deploy-mwitt.yml` failure after `UpdateFunctionCode` but before
  `UpdateAlias`: `:live` still points at previous version. **Rollback:** none.
- `deploy-mwitt.yml` failure after `UpdateAlias`: bad code is live. **Rollback:**
  `lambda:UpdateAlias` to previous tag's recorded version (stored in
  `mwitt-v*` tag annotation). UI artifact is replayable from the same tag.
- Settings.tsx 6-way merge defect: tab fails to render. Caught by
  `walk-settings.mjs` post-deploy gate; if it slips, rollback to prior tag.

## Rollback strategy

Every successful release tags `mwitt-v<ts>` with annotated message containing:

```
lambda_version=N
lambda_function=orbital-mwitt-api
ui_s3_etag=<index.html etag>
cloudfront_distribution=E28L1XYTKZTJQG
git_sha=<sha>
```

Rollback playbook (documented in `docs/releases.md`):

1. `git checkout mwitt-v<previous>`
2. Re-run `deploy-mwitt.yml` with `inputs.rollback_to=mwitt-v<previous>` —
   that path skips build, downloads the artifact recorded in the tag's
   release asset, and re-applies it.

## Trust boundary changes

Removes the human-and-agent ad-hoc path that does
`aws lambda update-function-code` from a developer workstation against
`orbital-mwitt-api`. After this rollout, that command should be denied for
human IAM principals; only the OIDC-assumed
`OrbitalGitHubDeployRole-mwitt` may mutate that function.

(That deny-policy on humans is **out of scope for this PR** — flagged for
follow-up; documented in `docs/releases.md` under "Hardening — TODO".)

## Cross-family review

Per Engineer-Principal hard rule: a non-Opus reviewer family must approve
this before `release/mwitt -> main`. Sonnet (Engineer-Sr) is the assigned
reviewer for the PR that merges this work into `main`.

## Confidence

- Pipeline plumbing (Parts 1, 2, walk-settings script): 92.
- Full integration of 17 branches + Settings.tsx 6-way merge + live deploy
  + walk-deep ≥20/20 + tag in this single execution window: **55**. Too
  many unknowns in real-world rebase conflicts. Will execute and report
  per-branch outcomes truthfully; will not fabricate "merged" status.
