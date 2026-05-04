# Integration Status — orbital-pipeline-2026-05-04

`release/mwitt` is established. Pipeline + scripts + docs committed and pushed.

## Integrated cleanly (4 / 17)

Merged into `release/mwitt` via `scripts/integrate-branch.sh` with `--no-ff`:

- `feat/settings-general` -> `56cb2de`
- `feat/settings-integrations` -> `9008dbd` (merge `ada396b`)
- `feat/real-claude-daemon` -> `765b9d1` (merge `91d114d`)
- `feat/story-pr-pipeline` -> `7c90e13` (merge `ba035c4`)

## Blocked on semantic-merge (13 / 17)

All 13 fail the same way: aggregator-file conflicts that git cannot resolve
(append-only registries where two branches each add a new entry). The
auto-resolver's "take ours" strategy works for `package-lock.json` and
`_journal.json` but cannot work for code aggregators where both sides'
additions must coexist.

| Branch                          | Conflicting aggregator(s)                                   |
|---------------------------------|-------------------------------------------------------------|
| `feat/settings-agents`          | `packages/orchestrator/src/trpc/routers/index.ts`           |
| `feat/settings-sprints`         | `packages/orchestrator/src/trpc/routers/index.ts`           |
| `feat/settings-team`            | `packages/db/src/index.ts`, `packages/ui/src/pages/Settings.tsx` |
| `feat/settings-billing`         | `packages/ui/src/pages/Settings.tsx`                        |
| `feat/github-app-install`       | `packages/orchestrator/src/trpc/routers/index.ts`           |
| `feat/vision-decompose`         | `packages/db/src/index.ts`                                  |
| `feat/sprint-loop`              | `infra/lib/constructs/daemon-fargate.ts`, `packages/db/src/index.ts`, `packages/orchestrator-daemon/src/main.ts` |
| `feat/pr-review-agent`          | `packages/db/src/index.ts`, `packages/db/src/schema/backlog.ts`, `packages/orchestrator/src/trpc/routers/index.ts` |
| `feat/ac-test-generation`       | `packages/db/src/index.ts`, `packages/orchestrator/src/trpc/routers/index.ts` |
| `feat/cost-guardrails`          | `packages/ui/src/pages/Settings.tsx`                        |
| `feat/obsidian-vault-sync`      | `packages/db/src/index.ts`, `packages/orchestrator/src/trpc/routers/index.ts` |
| `fix/multi-project-isolation`   | journal needs renumber; clean rebase otherwise              |
| `feat/memory-prompt-assembly`   | journal needs renumber; clean rebase otherwise              |

## Recommended path forward

Each blocked branch needs ~5–15 min of semantic merge work:

1. Rebase onto current `release/mwitt`.
2. For `packages/db/src/index.ts` and `packages/orchestrator/src/trpc/routers/index.ts`:
   accept the union of imports + the union of registry entries.
3. For `packages/ui/src/pages/Settings.tsx`: the canonical Settings.tsx
   already has all 6 tabs wired. Conflicts there are about *what* a tab
   renders inside its sub-route — keep the feature branch's component
   wiring under its tab path.
4. Run `node scripts/renumber-migrations.mjs` (already part of the driver).
5. Open PR feat/* -> release/mwitt; let `pr-check.yml` validate.

Recommend a small custom merge driver for the two trpc/db aggregator files
that does "union of import lines + union of property entries". That would
unblock 9 of the 13. I held back from auto-applying it without a test
harness for the resulting object literal (correctness depends on no
duplicate keys across branches; would need a manual scan).

## Pipeline status

- `release/mwitt` exists on origin: yes, pushed.
- `pr-check.yml`, `deploy-mwitt.yml`, `migrations.yml`: in repo, will fire
  on next push that triggers them.
- `OrbitalGitHubDeployRole-mwitt`: CDK construct ready (`infra/lib/constructs/github-oidc-role.ts`).
  **NOT YET DEPLOYED.** Requires `cdk deploy` against the mwitt stack
  with the construct wired into `orbital-hub-stack.ts` (one-line
  instantiation; intentionally left for the operator who will populate
  the GitHub secrets after the role ARN is known).
- GitHub Actions secrets: documented in `docs/releases.md`.
  **NOT YET POPULATED** — same reason.

## Parts 4, 5, 6 — not executed this turn

- **Part 4 (walk-settings):** script written + committed (`packages/ui/walk-settings.mjs`).
  Cannot run end-to-end yet because (a) the CDK role isn't deployed, (b) GH secrets
  aren't set, and (c) only 4 of 17 branches are integrated, so a deploy now would
  not represent the unified bundle the user asked for.
- **Part 5 (walk-deep ≥20/20):** depends on Part 4 prerequisites + a successful
  deploy of the unified bundle.
- **Part 6 (tag mwitt-v<ts>):** the workflow tags automatically on a successful
  `deploy-mwitt.yml` run. Will happen as a side-effect of the first real deploy.

## Confidence

- Pipeline scaffolding is real and would work end-to-end the moment the
  OIDC role + secrets land: **92**.
- Integration of the remaining 13 branches as posted PRs: **75** (depends
  on whether the union-merge approach uncovers latent semantic conflicts).
- "All 6 parts complete this turn" as originally scoped: **35** — the
  semantic merges are real engineering work, not mechanical.
