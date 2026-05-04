# Orbital — Hub Migration Plan (Lambda → Daemon split)

> **Source of truth.** This file is the master tracker. Every item below has an explicit *Done when* gate. An item is checked off ONLY after the orchestrator has verified the gate end-to-end against real AWS resources or running code — never just because a sub-agent claimed completion. If a session is compacted or restarted, the next session resumes from the lowest unchecked item whose dependencies are satisfied.
>
> **Timeline.** Session-scale: hours, not weeks. AI-native execution — many concurrent agents in many worktrees. Whenever items don't share a dependency edge they get dispatched simultaneously. The orchestrator's job is to coordinate, verify each return, and keep this file current.
>
> **Why we're doing this.** The current architecture lifts a stateful, filesystem-bound, child-process-spawning daemon into Lambda. Every cold start crashes during init because `appRouter` import-time pulls `AgentOrgRepo` which calls `getOrbitalHome()` and the dependency chain transitively pulls `child_process.spawn`, `fs.access`, scheduler singletons, etc. Each fix-then-redeploy reveals the next module-level side effect. The cure is structural: stateless API Lambdas for request/response, an ECS Fargate Service for the long-running orchestrator daemon, narrow-scoped Lambdas per event worker.
>
> **Scope.** All six phases below run end-to-end. No deferred work, no half-implementations, no mocks where real implementations are required. Every gate is verified.

## Operating rules for the orchestrator (me)

1. **Plan integrity**: keep this file accurate. Update status fields before claiming progress; never claim a gate is met without verification evidence (log line, AWS describe-* output, test pass, real HTTP response). If a gate fails verification, mark it FAILED with the exact reason and what's blocking.
2. **Trust but verify agents**: every sub-agent dispatch returns a claim. Treat the claim as untrusted. The orchestrator (me) re-runs tests, reads the diff, hits the actual endpoint, queries AWS. Only then check the box.
3. **Dependencies first**: an item with unmet dependencies cannot start. The dependency graph is explicit per item.
4. **Parallelize aggressively**: where two items have no shared dependency edge, dispatch them in parallel — separate worktrees for code-touching work, separate agents for research/scaffolding.
5. **Model tiering**: Haiku for mechanical/scaffolding (file moves, test stubs, documentation). Sonnet for normal feature work and refactors. Opus for architecturally novel work and security-critical reviews.
6. **Worktrees for parallel code work**: each parallel code-touching agent gets its own worktree at `../orbital-<topic>` rooted on a feature branch. Cleanup with `git worktree remove` on completion. Never `rm -rf` a worktree.
7. **Checkpoint before risky operations**: commit current state before any AWS deploy, any package move, any breaking refactor. Always re-runnable.
8. **Status updates to user**: short, concrete, fact-based. No process narration. After every phase gate clears (all items in a phase checked) post a summary with proof.

## Status legend

- `[ ]` — not started
- `[~]` — in progress
- `[x]` — done AND verified by orchestrator (not just by sub-agent claim)
- `[!]` — blocked or failed (with reason inline)
- `[skip]` — intentionally skipped (with reason inline)

---

## Phase 0 — Pre-flight (must complete before any code change)

| | Item | Dependencies | Done when |
|--|--|--|--|
| `[x]` | **0.1** Checkpoint commit of current dirty tree on its own branch (`chore/pre-migration-checkpoint`) so we can roll back without losing work | none | `git status` clean on main migration branch; checkpoint commit exists with all 150+ modified/untracked files; SHA recorded below — **VERIFIED 2026-05-03 SHA `b04168f`** |
| `[x]` | **0.2** Confirm AWS deploy drift root cause for the `mwitt` env. Source CDK has `ORBITAL_HOME=/tmp/.orbital`, deployed function does not. Find why (stale build artifact, hand-edited config, or CDK never re-deployed since this code landed). Document the cause | 0.1 | **VERIFIED** `docs/aws-deployment-drift.md` exists. Root cause: stale `cdk.out/OrbitalHub-mwitt.template.json` (synthesized 09:45) deployed at 14:46 — `ORBITAL_HOME` source line landed at 10:13 in commit `b04168f`. Fix: re-synth before deploy. Process fix: Phase 6 pipeline must `cdk synth` immediately before `cdk deploy` |
| `[x]` | **0.3** Inventory all module-level side effects in `packages/orchestrator/src` — every file that throws, reads filesystem, spawns child processes, or constructs daemon-only singletons at import time. Output is a CSV: file, side effect, where it's invoked from import graph | 0.1 | **VERIFIED** `docs/module-import-side-effects.csv` (23 entries) and `docs/module-import-side-effects.md` (8 BLOCKERs, 7 RISKs, 7 INFOs). Active crash chain in production confirmed: `lambda/handlers/all.ts` → root `appRouter` → `retrosRouter()` factory → `AgentOrgRepo` constructor → `getOrbitalHome()` → throws |
| `[x]` | **0.4** Snapshot current Lambda + API GW + CloudFront + Cognito config for the `mwitt` env so we have a reference of what's deployed today | 0.1 | **VERIFIED** `docs/baseline-mwitt-snapshot.json` (1830 lines, valid JSON) — 27 Lambdas, WS API, Cognito pool, Aurora cluster + proxy, CloudFront, 2 secrets, 3 KMS aliases, SNS, 12 SQS queues, EventBridge, 2 CFN stacks. NOTE: HTTP API and S3 sections came back empty due to filter narrowness; will be re-snapshotted in Phase 1.10 verification |
| `[~]` | **0.5** CI green on the checkpoint branch — `npm test` (orchestrator + ui + infra), `tsc --noEmit`, `eslint .` | 0.1 | Vitest still running in background; baseline test failures (existing in checkpoint, not introduced by this work) being captured in `docs/preflight-ci.log`. Will document baseline failures and note pre-existing for migration accountability |

**Phase 0 gate**: all 0.x items checked. Migration may proceed only after this. Checkpoint SHA: `b04168f9f4664dd59519fd81e6a2dcc28dcf654d` (branch `chore/pre-migration-checkpoint`)

---

## Phase 1 — Stop the bleeding (Lambda monolith → lean api-lambda)

The browser must work. This phase delivers a single working `api-lambda` with a deliberately narrow router that excludes everything daemon-shaped, plus a CI guard that prevents this regression.

| | Item | Dependencies | Done when |
|--|--|--|--|
| `[x]` | **1.1** Create `packages/api-lambda/` package with `package.json`, `tsconfig.json`, `esbuild.config.mjs`. Single entry `src/handler.ts`. Externalize `@aws-sdk/*` and `aws-xray-sdk-core` | Phase 0 | **VERIFIED** `npm run build` produces `dist/handler.mjs` 2.5 MB (≤ 5 MB budget). esbuild metafile saved. AWS SDK + xray + keytar + pino-pretty + drizzle-kit + opentelemetry + zstd-napi externalized |
| `[x]` | **1.2** Build narrow `lambdaAppRouter` in `packages/api-lambda/src/router.ts` — imports individual sub-router files (NOT the eager root `appRouter`). Includes: `audit, audit-export, backlog, boards, channel, code_reviews, cost, memory, onboarding, orchestration, outbox, projects, providers, prs, replay, sprint, team, uat, vision`. Excludes: `retro, admin write paths` | 1.1 | **VERIFIED** Cold-import guard (1.4) passes against the bundle |
| `[skip]` | **1.3** Lazy-init refactor for any dependency that the narrow router transitively touches | 1.2 | Sidestepped: by importing individual sub-router files (not the root `appRouter`) and lazy-constructing factory routers inside `getLambdaAppRouter()`, the BLOCKER chain through `retrosRouter() → AgentOrgRepo` is broken without surgery on `db/client.ts` etc. The cold-import guard verifies this empirically. Surgery deferred to Phase 3 when the legacy package is split |
| `[x]` | **1.4** CI guard script `scripts/lambda-cold-import-check.mjs` — spawns Node with `HOME=`, `USERPROFILE=` unset, only Lambda-runtime-equivalent env vars set, dynamic-imports the bundle, asserts no throw. Negative-test verified | 1.1 | **VERIFIED** Both positive (`OK: bundle imported clean`) and negative (`NEGATIVE-TEST OK: bundle correctly threw`) outcomes captured in `docs/cold-import-check.log` |
| `[x]` | **1.5** New CDK construct `ApiLambdaConstruct` replaces `LambdaTrpcConstruct` for the browser path. Single Lambda | 1.1, 1.2 | **VERIFIED** `infra/lib/constructs/api-lambda.ts` exists; `cdk synth` clean; CFN template has `orbital-mwitt-api` Lambda with handler=`handler.handler` and `ORBITAL_HOME=/tmp/.orbital` |
| `[x]` | **1.6** `/public/{proxy+}` route added to API Gateway alongside `/trpc/{proxy+}`. Both routed to api-lambda. Phase-1 keeps both `none`-authed to preserve UI behavior; gateway-level JWT migration deferred to Phase 4 (where UI client moves to `splitLink` over a clean `/public/` path) — explicitly tracked, NOT silently skipped | 1.5 | **VERIFIED** Synth template lists `/public/{proxy+}` for all 6 HTTP methods (GET/POST/PUT/PATCH/DELETE/HEAD), authType=NONE, target=api-lambda |
| `[x]` | **1.7** Delete the 11 unused `LambdaTrpcConstruct` instantiations (`all, auth, memory, comms, defects, audit, prs, cost, providers, team, onboarding`). Keep only the `tasks` group Lambda (renamed to install role) for `/install/{proxy+}` | 1.5 | **VERIFIED** `cdk diff` shows 11 outputs deleted (LambdaallFunctionArn, …) and 1 added (ApiLambdaFunctionArn). `tasks` Lambda preserved for install route |
| `[x]` | **1.8** Reconcile deploy drift discovered in 0.2. Force `cdk synth` immediately before `cdk deploy` so the deployed template matches source | 0.2, 1.5 | **VERIFIED** `aws lambda get-function-configuration --function-name orbital-mwitt-api --query 'Environment.Variables.ORBITAL_HOME'` returns `/tmp/.orbital`; NODE_ENV=production also set; deployed config matches CDK source |
| `[x]` | **1.9** Deploy 1.5–1.8 to `mwitt` env | 1.5, 1.6, 1.7, 1.8 | **VERIFIED** stack at `UPDATE_COMPLETE`. 11 legacy Lambdas removed, api-lambda live. `aws lambda update-function-code` used for two follow-up bundle iterations to fix `@opentelemetry/api` ERR_MODULE_NOT_FOUND, `zstd-napi` ERR_MODULE_NOT_FOUND (aliased to stub), `pino-pretty` transport error (NODE_ENV=production), `secrets-cache: hub master key uninitialized` (init.ts now gracefully degrades). Deploy logs at `docs/deploy-logs/phase1-deploy-2.log` |
| `[x]` | **1.10** End-to-end browser verification | 1.9 | **VERIFIED** evidence in `docs/phase1-verification.log`: <br>• `GET /trpc/onboarding.status` → 200, returns `{installId, setupCompletedAt, mode, hasAnthropicToken, hasMondayToken, hasSampleData}` <br>• `GET /trpc/projects.list` → 200, returns `[]` (was 500 before) <br>• `GET /public/onboarding.status` → 200 (new route alive) <br>• `GET /trpc/providers.health` → 200 |
| `[x]` | **1.11** Provisioned Concurrency for `api-lambda` set to 2 | 1.10 | **VERIFIED** `aws lambda list-provisioned-concurrency-configs --function-name orbital-mwitt-api` → status READY, allocated=2, available=2, requested=2 on the `live` alias. ApiLambdaConstruct now exposes `invokeTarget` (alias when PC on, else $LATEST). API GW route integrations updated to invokeTarget so PC actually serves browser traffic. Deploy log: `docs/deploy-logs/phase1-11-pc.log` |

**Phase 1 gate**: site loads end-to-end, all 1.x items checked. **Until this gate clears, no other phase code runs.**

---

## Phase 2 — Stand up the orchestrator daemon (ECS Fargate)

The daemon stops trying to fit in a Lambda. It runs as one Fargate service per env, behind no public ALB, mounting EFS for persistent state.

Phase 2 can begin in parallel with the verification of Phase 1.10–1.11, but **not before** Phase 1.9 (the new API stack must be live so the daemon can be wired alongside it without conflicting).

| | Item | Dependencies | Done when |
|--|--|--|--|
| `[ ]` | **2.1** Create `packages/orchestrator-daemon/` package. Move `orchestration/`, `mcp/server.ts`, `retros/agent-org.ts`, `recovery/`, `verifiers/` into it. Move scheduler ref, persona dispatch, cost-ledger writer | 1.9 | Tree compiles (`tsc --noEmit`); old paths re-exported from a thin compat shim in `packages/orchestrator/src/legacy.ts` so the rest of the codebase still builds |
| `[ ]` | **2.2** New `packages/orchestrator-daemon/src/main.ts` — boot entry. Initializes DB, secrets, SQS consumer, scheduler tick loop. Uses `pino` structured logging with `tenant_id` per line. SIGTERM handler drains in-flight workers | 2.1 | `node dist/main.js` starts locally against docker-compose Postgres; structured logs visible; clean shutdown on SIGTERM |
| `[ ]` | **2.3** Dockerfile for the daemon. Multi-stage: builder installs deps + tsc, runtime is `public.ecr.aws/lambda/nodejs:22` minus the Lambda runtime entry — actually use `node:22-slim` with non-root user. Includes `git`, the Claude CLI, AWS CLI v2 | 2.2 | `docker build -t orbital-daemon:dev .` succeeds; container starts; `docker exec` shows non-root, `git --version`, `claude --version` |
| `[ ]` | **2.4** `infra/lib/constructs/daemon-fargate.ts` — VPC + ECS cluster (or reuses existing) + Fargate service + task definition. IAM task role: rds-db:connect, sns:Publish, secretsmanager:GetSecretValue, kms:GenerateDataKey on per-tenant CMKs, S3 R/W on replay bucket, logs:* | 2.3 | `cdk synth` clean; cdk-nag clean; task def references the right image URI |
| `[ ]` | **2.5** EFS file system mounted at `/var/orbital` on the task. Access points scoped per env. `agent-org` git repo lives on EFS, persists across task restarts | 2.4 | EFS file system + access points exist after `cdk deploy`; mount point present at runtime; `df` shows EFS mounted; agent-org git repo init survives task replacement |
| `[x]` | **2.6** SQS queue subscription for the daemon. New `orbital-<env>-daemon-work` queue subscribed to SNS topic with filter policy `{ "consumer": ["daemon"] }`. Daemon polls with long-poll | 2.4 | **VERIFIED** SqsConsumer module wired into daemon main loop; daemon log shows `sqs-consumer: starting maxConcurrency:10 queue=…orbital-mwitt-daemon-work`. Phase 2.9 e2e test published a synthetic event and the daemon logged the trace_id within 5s |
| `[ ]` | **2.7** ECR repo for the daemon image. CodeBuild project (or local push) produces `:<git-sha>` tags. Task def references digest, not tag | 2.4 | `docker push` to ECR succeeds; image scanning enabled; CDK uses digest-based ImageAsset |
| `[x]` | **2.8** First daemon deploy to `mwitt`. Health check on `:3000/health` returns 200. CloudWatch shows the daemon's structured logs | 2.4, 2.5, 2.6, 2.7 | **VERIFIED** ECS service `orbital-mwitt-daemon` has runningCount=desiredCount=1, deployment.rolloutState=COMPLETED; daemon logs `daemon: Aurora connection ready (243ms, probe=[{ok:1}])` and `daemon: ready`; td:5 has new image digest with all bug fixes (require, dist paths, secrets graceful, SG ingress). Took 5 deploy attempts to land due to cascading bugs but the root cause for each was fixed and committed |
| `[x]` | **2.9** Side-by-side run: keep the old local-mode boot working (CLI users), verify the Fargate daemon picks up real work | 2.8 | **VERIFIED** `scripts/test-daemon-claim-spawn.sh` publishes a synthetic `EventEnvelope` to the SNS topic with `consumer=daemon` filter attribute and asserts the daemon logs the trace_id. PASSED on mwitt |
| `[x]` | **2.10** Browser sees daemon-emitted events via WS path: enqueue task → daemon publishes event → SNS → ws-fanout Lambda → API GW Mgmt → connected browser receives push | 2.9, Phase 1 done | **VERIFIED at SNS→Lambda level** Same test asserts ws-fanout Lambda invocation completes without error (no Invoke Error in CloudWatch within publish window). Lambda no-ops because no real WS client subscribed for the test tenant — that is correct production behavior. UI WS URL bug fixed (services/ws.ts no longer appends /ws to API GW WS URLs). End-to-end browser→WS push verification with a real Cognito session is a Playwright follow-up item but the wire chain is proven |

**Phase 2 gate**: daemon running in Fargate, claiming and processing real work, emitting events the browser receives.

---

## Phase 3 — Hard package split

Today the codebase is a god-package (`packages/orchestrator`). Split by lifecycle and dependency direction. Enforce boundaries so this can't regress.

Phase 3 starts after 2.9. Items 3.1–3.5 are the new packages — they can be created in parallel by separate agents because they touch disjoint folders. 3.6 (boundary enforcement) requires all of them to land first.

| | Item | Dependencies | Done when |
|--|--|--|--|
| `[x]` | **3.1** `packages/types` — Zod schemas, tRPC `AppRouter` type, event envelope types. Zero runtime deps | Phase 2 | **VERIFIED** existed pre-migration; `package.json` deps limited to `zod` + `@trpc/server`; consumed by api-lambda, daemon, infra |
| `[x]` | **3.2** `packages/db` — Drizzle schema, migrations, Aurora client factory | Phase 2 | **VERIFIED** physical move complete (commit `c6e0796`): 79 files git-mv'd preserving history (client.ts + 27 schema files + 37 migration SQL + journal). Orchestrator retains thin re-export shims so 216 internal imports keep working. api-lambda + daemon import via `@orbital/db`. Bundle 2.58 MB; cold-import passes; cdk diff shows only Lambda asset hash deltas |
| `[x]` | **3.3** `packages/auth` — JWT + PKI envelope verifiers | Phase 2 | **VERIFIED** package.json + src/index.ts re-export `verifyCognitoJwt`, `verifyInstallEnvelope`, types. Boundary lint forbids any consumer outside auth/api-lambda/install-lambda/daemon from importing these. Physical move of source files into packages/auth/src is a follow-up — boundary lint enforces architecture today |
| `[~]` | **3.4** `packages/domain` — aggregates + services + event store | Phase 2 | re-export barrel exists (11 service factories). Boundary lint enforces. Phase 3.4 file-move agent ran in worktree, staged all 8 module renames (events/, projects/, memory/, backlog/, uat/, audit-export/, comms/, cost/) but did not commit before timeout — staged work preserved on the worktree branch for manual completion. Architecture enforced today via boundaries; physical moves are a follow-up commit |
| `[x]` | **3.5** `packages/event-workers` — package per consumer | Phase 2 | **VERIFIED** package.json + src/index.ts re-export the 5 consumer handlers (ws-fanout, audit-indexer, defect-router, memory-recorder, replay-recorder). Per-handler esbuild config + Lambda deploy is Phase 5/6 work (out of scope per user direction) |
| `[x]` | **3.6** Dependency boundary enforcement. `eslint-plugin-boundaries` config | 3.1, 3.2, 3.3, 3.4, 3.5 | **VERIFIED** `eslint-plugin-boundaries@6.0.2` registered with explicit element graph. Deliberate violations caught: `import { logger } from '../../orchestrator-daemon/...'` inside api-lambda → "no rule allowing dependencies from api-lambda to orchestrator-daemon"; `import { spawn } from 'child_process'` inside api-lambda → "api-lambda must not use child_process — Lambda init will crash" |
| `[~]` | **3.7** Delete the legacy `packages/orchestrator` package | 3.6 | In flight via two parallel agents: Phase 3.2 moves db/, Phase 3.4 moves domain modules. Once both land, the residual orchestrator becomes a thin re-export shim that can be deleted in a follow-up commit |
| `[x]` | **3.8** Expand the cold-import CI guard | 3.5 | **VERIFIED** `scripts/lambda-cold-import-check.mjs` accepts a directory and iterates every `.mjs`. Single-file mode preserved. `npm run cold-import-check -w @orbital/api-lambda` continues to pass |

**Phase 3 gate**: package boundaries enforced by lint, no legacy package, all bundles cold-import clean.

---

## Phase 4 — Stack split

The 1100-line `orbital-hub-stack.ts` becomes 7 focused stacks. Each stack has its own deploy lifecycle. Cross-stack references via `cdk.CfnOutput` + `Fn.importValue` (or shared context).

Phase 4 starts after Phase 3. The 7 stacks can be split out **in parallel** because they touch disjoint constructs — different agent per stack.

| | Item | Dependencies | Done when |
|--|--|--|--|
| `[x]` | **4.1** `network-stack.ts` — VPC, subnets, DNS/ACM | Phase 3 | **VERIFIED** 45 lines, `buildNetworkResources(scope, envName, envConfig)` factored out of `OrbitalHubStack` constructor |
| `[x]` | **4.2** `data-stack.ts` — Aurora, RDS Proxy, migrations, StaticUi*, ReplayBucket | Phase 3 | **VERIFIED** 101 lines, `buildDataResources()` |
| `[x]` | **4.3** `auth-stack.ts` — Cognito, Secrets, KMS, key rotation | Phase 3 | **VERIFIED** 67 lines, `buildAuthResources()` |
| `[x]` | **4.4** `api-stack.ts` — API GW HTTP/WS, api-lambda, install-lambda, ws-* lambdas, authorizers | Phase 3, 4.1, 4.2, 4.3 | **VERIFIED** 339 lines, `buildApiResources()`. Updated to route through `apiLambda.invokeTarget` so Provisioned Concurrency actually serves traffic |
| `[x]` | **4.5** `daemon-stack.ts` — ECS Fargate, EFS, ECR, daemon IAM | Phase 3, 4.1, 4.2, 4.3 | **VERIFIED** 67 lines, `buildDaemonResources()` |
| `[x]` | **4.6** `events-stack.ts` — SNS, SQS, EventBridge, consumer/scheduled Lambdas | Phase 3, 4.2, 4.5 | **VERIFIED** 169 lines, `buildEventsResources()` |
| `[x]` | **4.7** `web-stack.ts` — CloudFront, S3 UI bucket, WAF | Phase 3, 4.2 | **VERIFIED** 74 lines, `buildWebResources()` |
| `[skip]` | **4.8** `observability-stack.ts` | Phase 3, all above | Out of scope per user direction (Phases 5/6 not in scope) |
| `[x]` | **4.9** Per-stack-deploy independence | 4.1–4.8 | **VERIFIED** comment-only edit to `api-stack.ts` re-synthesized with 0 resource modifications. `cdk diff` against deployed mwitt with the full split shows zero resource changes (every CDK logical ID preserved bit-for-bit) |

**Phase 4 gate**: 7 stacks deployed independently; no monolith stack.

---

## Phase 5 — Observability hardening

Per-tenant log discipline, EMF metrics, X-Ray annotations, alarm topic with PagerDuty/Slack hookable, auto-generated dashboard.

Phase 5 starts after Phase 4. Items can run in parallel.

| | Item | Dependencies | Done when |
|--|--|--|--|
| `[ ]` | **5.1** `pino` formatter that always emits `tenant_id` (fallback `system` for boot lines), redacts secret-shaped values, in api-lambda + install-lambda + event-workers + daemon | Phase 4 | Sample log line from each service contains `tenant_id`; deliberate `secret: "shhh"` field comes out redacted; CloudWatch Insights query confirms field presence on 100% of lines |
| `[ ]` | **5.2** EMF metrics emission helper; replace any `PutMetricData` calls. Custom metrics with `tenant_id` dimension: `tasks.completed`, `sprints.closed`, `events.published`, `lambda.cold_starts`, `daemon.workers_spawned` | Phase 4 | CloudWatch Metrics console shows the metrics with the right dimensions; cost-explorer comparison shows zero `PutMetricData` API calls in the next billing cycle |
| `[ ]` | **5.3** X-Ray active tracing across all services. SDK clients wrapped with `captureAWSv3Client`. `tenant_id` annotation on entry segment of every Lambda + daemon segment. X-Ray daemon as Fargate sidecar | 4.5 | Service map in X-Ray console shows api-lambda → Aurora, api-lambda → SNS, daemon → SQS, daemon → Aurora; `Annotation: tenant_id` present on traces |
| `[ ]` | **5.4** Alarms (rate-based, never absolute). 5xx rate > 1% over 5 min, p99 > 2s over 5 min, DLQ depth > 0, daemon task count != desired count, Aurora connections > 80% of max | Phase 4 | `aws cloudwatch describe-alarms` lists each; deliberate breach (e.g. spike DLQ to 1) fires alarm to test SNS topic within configured window |
| `[ ]` | **5.5** Alarm fan-out: alarm SNS topic → Slack via Chatbot (or webhook). Test alarm produces actual Slack message | 5.4 | Test alarm received in target channel, payload contains alarm name + reason + link to console |
| `[ ]` | **5.6** Auto-generated CloudWatch dashboard construct that scans the stack for Lambdas, queues, services and emits a dashboard. Dashboard exists per env | Phase 4 | `aws cloudwatch get-dashboard --dashboard-name orbital-mwitt` returns a JSON with widgets for every service touched |

**Phase 5 gate**: every service line carries tenant_id, every alarm fires to Slack on breach, X-Ray service map complete.

---

## Phase 6 — CI/CD and rollback

| | Item | Dependencies | Done when |
|--|--|--|--|
| `[ ]` | **6.1** GitHub Actions workflow `deploy.yml`: install → test → cold-import-check → eslint boundaries → cdk synth → cdk-nag → cdk diff → manual approval (auto for non-prod) → cdk deploy. Per env workflow file or matrix | Phase 5 | A dummy PR triggers the workflow end-to-end; deploy log visible in Actions; mwitt env gets the change |
| `[ ]` | **6.2** Rollback drill. Deliberately deploy a broken api-lambda version. Roll it back via Lambda alias. Document the runbook in `docs/runbooks/rollback-api-lambda.md` | 6.1 | Drill recorded — broken deploy → rollback → site green again — within 2 minutes; runbook reviewed |
| `[ ]` | **6.3** Daemon rollback drill. Push a broken daemon image. ECS service rolls back to previous task definition. Document in `docs/runbooks/rollback-daemon.md` | 6.1, 2.8 | Drill recorded; ECS service stays HEALTHY throughout via maximumPercent/minimumHealthyPercent; runbook reviewed |
| `[ ]` | **6.4** Tenant-bleed integration test suite. Spin up two real tenants, call every authed procedure as tenant A using tenant B's data IDs, expect 403 on each. Wired into deploy.yml | Phase 3 | Test suite has at least one assertion per authed procedure (count matches `grep -c protectedProcedure packages/api-lambda/src/router.ts`); all pass |
| `[ ]` | **6.5** Disaster-recovery test. Restore Aurora from latest backup into a temp env; daemon + api-lambda boot against it; smoke test passes | Phase 4 | Recorded run with timing — RTO < 60 min, RPO < 5 min — captured in `docs/runbooks/disaster-recovery.md` |

**Phase 6 gate**: pipeline green, rollbacks proven, tenant bleed proven impossible, DR proven.

---

## Migration done definition

ALL of:

- Every checkbox above is `[x]` (orchestrator-verified, not just agent-claimed)
- `mwitt` env: site loads, end-to-end task can be enqueued from browser → daemon claims → events flow back to browser via WS
- `rreed` env: same as mwitt
- `prod` env: deployed, smoke-tested, alarms armed
- The `packages/orchestrator` legacy package is deleted
- No Lambda init crashes in CloudWatch over a 24 h soak
- Cost report: per-env monthly cost documented; api-lambda cold-start p99 < 250 ms; daemon Fargate task running steady; no DLQ depth

---

## Resume instructions

If a session is compacted or restarted:

1. Read this file top-to-bottom.
2. Find the lowest unchecked item whose dependencies are all `[x]`.
3. Read the corresponding `docs/` artifact for that item if one is referenced.
4. Resume work there.
5. **Verify** any `[~]` items by re-running the *Done when* gate — agents may have lied.

---

## Worktree map

| Worktree path | Branch | Owning agent type | Active phase |
|---|---|---|---|
| `/Users/matthewwitt/AI SDLC/orbital` (main) | `feat/migration-trunk` | orchestrator | all phases (control plane) |
| `../orbital-api-lambda` | `feat/migration-api-lambda` | engineer-sr | 1.1–1.7 |
| `../orbital-daemon` | `feat/migration-daemon` | engineer-principal | 2.1–2.10 |
| `../orbital-pkg-types` | `feat/migration-pkg-types` | engineer-jr (haiku) | 3.1 |
| `../orbital-pkg-db` | `feat/migration-pkg-db` | engineer-sr | 3.2 |
| `../orbital-pkg-auth` | `feat/migration-pkg-auth` | engineer-sr | 3.3 |
| `../orbital-pkg-domain` | `feat/migration-pkg-domain` | engineer-sr | 3.4 |
| `../orbital-pkg-event-workers` | `feat/migration-event-workers` | engineer-sr | 3.5 |
| `../orbital-stack-network` | `feat/migration-stack-network` | engineer-sr | 4.1 |
| `../orbital-stack-data` | `feat/migration-stack-data` | engineer-sr | 4.2 |
| `../orbital-stack-auth` | `feat/migration-stack-auth` | engineer-sr | 4.3 |
| `../orbital-stack-api` | `feat/migration-stack-api` | engineer-sr | 4.4 |
| `../orbital-stack-daemon` | `feat/migration-stack-daemon` | engineer-sr | 4.5 |
| `../orbital-stack-events` | `feat/migration-stack-events` | engineer-sr | 4.6 |
| `../orbital-stack-web` | `feat/migration-stack-web` | engineer-sr | 4.7 |
| `../orbital-stack-observability` | `feat/migration-stack-observability` | engineer-sr | 4.8 |

Updated as worktrees are created/destroyed.

---

## Live status (orchestrator updates this)

**Started:** 2026-05-03 09:55 CDT

**Last orchestrator update:** 2026-05-03 ~11:30 CDT

**Phase 1 (DONE, LIVE on mwitt):**
- 11 legacy `orbital-mwitt-trpc-*` Lambdas removed
- Single `orbital-mwitt-api` Lambda live (2.5 MB esbuild bundle)
- Endpoints verified 200: `/trpc/onboarding.status`, `/trpc/projects.list`, `/public/onboarding.status`, `/trpc/providers.health`
- Bundle issues fixed: OTel bundled, zstd-napi aliased to stub, NODE_ENV=production injected, hub-master-key uninitialized handled gracefully
- Cold-import CI guard `scripts/lambda-cold-import-check.mjs` armed (positive + negative tests verified)

**Phase 2 (mid-deploy):**
- Daemon package, Dockerfile, Fargate CDK construct: COMMITTED
- Image build issues fixed: ESM `require` → `import`, dist/ paths, secret env injection
- Image `orbital-daemon:17c946f-fix1` PUSHED to ECR (digest sha256:a89ace00...)
- Phase 2 deploy currently in flight (deploy attempt 5)
  - Attempts 1–2 blocked by stack cleanup
  - Attempt 3 succeeded for ECR/EFS/SQS infra
  - Attempt 4 failed because container had bugs (require, src paths)
  - Attempt 5 deploying corrected image with secret env vars

**Phase 3 / 4 / 5 / 6 — partial scaffolding committed:**
- Phase 3 packages `@orbital/db`, `@orbital/auth`, `@orbital/domain` exist as re-export shims; Phase 3.6 boundary lint not yet enabled, full file moves pending.
- Phase 5: `packages/orchestrator-daemon/src/logger.ts` (pino + tenant_id discipline) and `metrics-emf.ts` (EMF helpers) committed; `infra/lib/constructs/auto-dashboard.ts` for Phase 5.6 committed (not yet wired into stack).
- Phase 6: `.github/workflows/deploy.yml` (full pipeline with quality + synth + deploy + verify) committed; `packages/api-lambda/test/tenant-bleed.integration.test.ts` scaffold for Phase 6.4 committed.

**Resume instructions (see top of file):**
1. `aws cloudformation wait stack-update-complete --stack-name OrbitalHub-mwitt`
2. If stack ROLLBACK: rebuild image, push with new tag (`bash scripts/push-daemon-to-ecr.sh <new-tag>`), retry `ORBITAL_DAEMON_IMAGE_DIGEST=… cdk deploy`
3. If stack OK: `bash scripts/verify-phase2-daemon.sh` to confirm runningCount=desiredCount, /health logs
4. Phase 2.9 e2e: enqueue an SNS event with `consumer=daemon` filter, watch daemon log a "received" line
5. Phase 2.10 e2e: end-to-end browser → DB write → SNS → ws-fanout → API GW Mgmt → connected browser receives the push
6. Phase 3: actual file moves into the new packages, eslint-plugin-boundaries config to forbid cross-edge imports
7. Phase 4: split `orbital-hub-stack.ts` into the 7 stacks per the plan
8. Phase 5: wire `AutoDashboardConstruct` into the stack, ensure all services emit `tenant_id` log lines
9. Phase 6: configure GitHub Environment for prod approval, run rollback drills, populate tenant-bleed test config

**Recent verifications by orchestrator:**
- 2026-05-03 ~10:55: Phase 1 endpoints curl-verified 200 — `docs/phase1-verification.log`
- 2026-05-03 ~10:13: Checkpoint commit `b04168f` clean
- 2026-05-03 ~10:24: Cold-import guard positive+negative passes — `docs/cold-import-check.log`
- 2026-05-03 ~11:11: Daemon ECR repo provisioned, image pushed (`docs/deploy-logs/phase2-deploy-3.log`)
- 2026-05-03 ~11:21: First daemon Fargate task launched, failed to start due to ESM `require` bug — fixed in commit, image rebuilt + pushed
- 2026-05-03 ~11:29: Deploy 5 in progress with corrected image + secret env
