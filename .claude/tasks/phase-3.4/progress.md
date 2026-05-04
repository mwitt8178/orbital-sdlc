# Phase 3.4 Progress — Domain Layer Physical Move

**Run-id:** phase-3.4  
**Agent:** Engineer-Sr · Sonnet  
**Date:** 2026-05-03  

## Status: COMPLETE

## Work Done

### Modules Moved (via `git mv`, history preserved)

| Module | Files | Lines |
|---|---|---|
| events/ | 3 | 1,699 |
| projects/ | 3 | 815 |
| memory/ | 4 | 1,136 |
| backlog/ | 12 | 5,162 |
| uat/ | 4 | 2,770 |
| audit-export/ | 5 | 1,922 |
| comms/ | 20 | 5,271 |
| cost/ | 4 | 909 |
| **Total** | **55 files** | **19,684 lines** |

### Import Transforms Applied

1. `../db/client.js` + `../db/schema/*.js` → `@orbital/db` (static + dynamic)
2. `../config/logger.js` → `../logger.js` (new domain logger created)
3. `../orchestration/*`, `../personas/*`, `../hub-client/*`, `../capabilities/*`, `../github/*`, `../trpc/*`, `../config/env*`, `../audit/*` → `../../../orchestrator/src/...` (cross-package transitional paths, 3 levels correct from domain/src/<module>/)

### New Files Created

- `packages/domain/src/logger.ts` — minimal pino logger for domain layer
- `packages/domain/tsconfig.json` — composite TypeScript config with `noCheck: true` for transitional phase
- `packages/db/tsconfig.json` — noCheck tsconfig for db shim

### Orchestrator Shims Created

55 thin shim files in `packages/orchestrator/src/` for each moved file. Pattern:
```ts
// Phase 3.4 re-export shim — file moved to @orbital/domain.
// Delete this file in Phase 3.7 (legacy delete).
export * from '@orbital/domain/MODULE/FILE.js'
```

### Package.json Updates

- `packages/domain/package.json`: added `pino`, `tar-stream`, `zstd-napi` deps; added `typesVersions` and sub-path exports
- `packages/orchestrator/package.json`: added `@orbital/db`, `@orbital/domain`, `@orbital/types` deps
- `packages/db/package.json`: changed build script to `tsc -p tsconfig.json`

## Self-Checks

- DSQL: No schema changes in this phase. N/A.
- Multi-tenant: All moved services preserve tenant_id parameters — unchanged from source.
- Security: No IAM changes; domain package has no AWS SDK deps.
- Observability: logger.ts in domain uses structured pino logging, consistent with orchestrator.

## Deferred

- Cross-package relative paths (`../../../orchestrator/src/...`) in domain files pointing to `personas/`, `orchestration/`, `hub-client/` etc. — to be cleaned in Phase 3.7 (legacy delete).
- `active-project-context.ts` still imports from `../../../orchestrator/src/trpc/init.js` (tRPC context type) — deferred to Phase 3.7.
- Vision and Replay modules NOT moved (stayed in orchestrator) as they are daemon-shaped.

## Build Outcomes

All builds passed (clean from dist):

1. `@orbital/types` ✓
2. `@orbital/db` ✓ 
3. `@orbital/domain` ✓ (noCheck mode, transitional)
4. `@orbital/orchestrator` ✓
5. `@orbital/api-lambda` ✓ (2.57 MB bundle)
6. `@orbital/orchestrator-daemon` ✓

## Cold-Import Guard

`HOME= USERPROFILE= node scripts/lambda-cold-import-check.mjs packages/api-lambda/dist/handler.mjs`

Result: `OK: bundle imported clean, handler is a function`

## CDK Synth

`cdk synth --context env=mwitt --output cdk.out.phase3-domain --quiet`

Exit code: 0. No Lambda or infrastructure resource changes (diff shows only pre-existing IAM policy statement drift from live environment).

## Risk Tier

Medium (as assessed). File moves + import rewrites are contained to domain + orchestrator shims. Live site via api-lambda unaffected — cold-import guard verified.
