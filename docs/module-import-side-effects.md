# Module Import Side-Effects Audit

Generated 2026-05-03. Target: `packages/orchestrator/src/`. CSV detail at [docs/module-import-side-effects.csv](module-import-side-effects.csv).

## Totals by severity

| Severity | Count |
|----------|-------|
| BLOCKER  | 8 |
| RISK     | 7 |
| INFO     | 7 |

## The Lambda cold-start crash chain in production today

```
lambda/handlers/all.ts
  └─ imports `appRouter` from trpc/routers/index.ts
      └─ trpc/routers/index.ts evaluates `export const appRouter = router({ ..., retro: retrosRouter(), ... })`
          └─ retrosRouter() factory called eagerly
              └─ createAgentOrgRepo() called inside retrosRouter()
                  └─ new AgentOrgRepo() constructor evaluates `path.join(getOrbitalHome(), 'agent-org')`
                      └─ getOrbitalHome() reads ORBITAL_HOME or HOME
                          └─ both unset on the deployed Lambda → THROWS
                              "Cannot resolve user home directory"
```

This is the only BLOCKER that actively crashes the deployed function today. The other BLOCKERs (loadEnv-at-top, db Proxy idempotency middleware, etc.) survive Lambda's env config because the relevant env vars are set or the dangerous code path is in a `if (ORBITAL_DEPLOY_TARGET !== 'aws')` guard. They remain latent risks: any future change that surfaces a missing env, or any new module-level side effect, breaks Lambda init.

## Top BLOCKERs

### 1. `db/client.ts` — Postgres connection opened at module load
- `const e = loadEnv()` at line 41
- `buildLocalDb()` runs synchronously when `ORBITAL_DEPLOY_TARGET !== 'aws'`
- **Fix:** delete the synchronous `db`/`sql` Proxy exports; export only the async `getDb()`. All callers (which already mostly use `getDb()` in the AWS branch) updated.

### 2. `config/logger.ts` — `loadEnv()` and pino-pretty worker
- Line 5: `const e = loadEnv()`
- pino-pretty transport spawns a worker thread in dev
- **Fix:** lazy-init logger inside `getLogger()`; call `loadEnv()` only on first use; transport defaults to JSON unless explicit dev mode.

### 3. `trpc/init.ts` — `createIdempotencyMiddleware({ db })` at module top-level
- Line 68
- Constructs middleware with the `db` Proxy (cheap), but the `db` import triggers `db/client.ts` evaluation
- **Fix:** Move construction inside an accessor; or accept that with #1 fixed this becomes a no-op.

### 4. `trpc/routers/index.ts` — eager appRouter construction
- Lines 328–366: `export const appRouter = router({ backlog: backlogRouter(), sprint: sprintRouter(), uat: uatRouter(), retro: retrosRouter(), ... })`
- Every factory called at module evaluation
- **Fix:** for `api-lambda`, build a NEW narrow router (`packages/api-lambda/src/router.ts`) that imports individual sub-router modules directly, skipping the root `index.ts`. Daemon still uses the eager `appRouter` for now.

### 5. `retros/agent-org.ts` — `getOrbitalHome()` in constructor
- Lines 27, 70
- AgentOrgRepo constructor reads `getOrbitalHome()`
- `child_process.execFileSync` imported module-top
- **Fix:** AgentOrgRepo is daemon-only. Remove from any Lambda import graph by excluding `retro` from `lambdaAppRouter`. In the medium term (Phase 3), AgentOrgRepo moves entirely to `packages/orchestrator-daemon`.

### 6. `lambda/lambda-trpc-adapter.ts` — `getRouter()` invoked in awsLambdaRequestHandler ctor
- Line 151: the thunk is invoked immediately
- **Fix:** even if the thunk pattern were lazy, the `import { appRouter }` is eager. Replace with a router-by-construction passed in directly. New `packages/api-lambda/src/handler.ts` constructs handler with the narrow router, no thunk.

## Recommended remediation patterns

| Pattern | Applicable to |
|---------|---------------|
| Lazy-init factory (`let _x = null; function getX() { if (!_x) _x = ...; return _x }`) | db/client.ts, config/logger.ts, trpc/init.ts idempotency |
| Move construction out of module scope into Lambda handler factory function | trpc/routers/index.ts appRouter, lambda/lambda-trpc-adapter.ts |
| Dependency injection at call site (pass `path` explicitly) | retros/agent-org.ts constructor |
| Dynamic import for `child_process` modules behind runtime guard | uat/persona-of-record.ts, recovery/io.ts |
| env.ts — guard `loadEnv()` against throwing on missing optional fields | config/env.ts |

## Strategy for Phase 1

We do **not** lazy-init every BLOCKER right now. We sidestep them by building `packages/api-lambda/` with its OWN router that imports individual sub-router modules. Sub-routers we choose to include must themselves be import-time-clean — the cold-import CI guard (Phase 1.4) verifies this against every bundle.

Allowed sub-routers in the narrow `lambdaAppRouter`:
- `auth, channel, audit, audit-export (read), vision (read-only), backlog, sprint, uat, onboarding, admin (read-only ops only), projects, boards, memory, providers, prs, replay (read), cost (read), code-reviews (read), team, outbox`

Excluded from the narrow router (daemon-shaped):
- `retro` — agent-org git, persona spawn
- `replay` write paths — replay recorder is daemon
- `code-reviews` write paths — reviewer persona spawn
- everything under `orchestration/` (scheduler, spawn, worktree)
- `mcp/server` (Unix socket)

If an excluded router has a procedure the browser needs, it goes through the Outbox → SNS → daemon path, with the daemon doing the actual work and emitting an event the browser receives.
