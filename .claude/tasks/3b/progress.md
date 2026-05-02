# Task 3B — Hook Engine + Verifiers

run-id: 3b-2026-05-01

## Self-checks

### DSQL/multi-tenant/security/observability
- No DSQL here (Postgres local) — N/A
- Multi-tenant: Not applicable; this is the orchestrator service with no tenant sharding
- Security: HookEngine fail-closed; SoD enforced at CBAC layer; verifier capability no files_write/board_mutate
- Observability: All events via EventStore.append; hook_invocations table; trace_id propagated

### Scope notes
- Migration number per task spec is 0008_determinism (Implementation Plan says 0007, but journal already has 0006; and task prompt says 0008 — using 0008)
- Phase 3A owns comms/ migrations (0007 is likely 3A's). Using 0008 as specified in task prompt.

## TDD Cycles

### Cycle 1 — RED
- hooks/types.ts Zod schemas
- hooks/engine.ts HookEngine
- hooks/loader.ts HookLoader
- baseline hooks (pre-commit, pre-status-transition, pre-merge, post-task)
- verifiers/service.ts VerifierService
- verifiers/sod.ts

### Cycle 2 — GREEN
- All unit tests pass

### Cycle 3 — REFACTOR
- Integration tests pass

## Build Fix (session continuation)

- `npm run build` was failing with 7 TypeScript errors in Phase 3A files. Fixed:
  1. `src/mcp/tools/channel_post.ts:28` — `CHANNEL_POST_TYPE.filter(...)` returns `string[]` but `z.enum()` requires tuple. Fixed with `as [string, ...string[]]` cast.
  2. `src/mcp/registry.ts` — `register(tool: MCPTool)` used default `ZodTypeAny` generics causing contravariance failures when registering concrete tools. Changed to `MCPTool<any, any>` on register signature. All 3 call sites in `src/index.ts` and `src/orchestration/registry-bootstrap.ts` resolved automatically.
  3. `src/verifiers/sod.ts` — `assertVerifierSod` used `require('@orbital/types')` (CommonJS dynamic import) inside an ESM module function. Fixed to top-level static `import { OrbitalError }`.
- Added missing `test/unit/hooks/baseline-pre-merge.test.ts` (12 tests) — pre-merge hook had implementation but no test file.
- Build clean: `npx tsc --noEmit` → no errors; `npm run build` → clean.
- Phase 3B tests: 80 tests passing (engine unit×9, pre-commit×15, pre-status-transition×19, post-task×9, pre-merge×12, verifier service×11, integration×5).
- Remaining failures (6) all in comms/ territory — Phase 3A owned, not Phase 3B.

## Deferred
- Hook catalog UI (tRPC routers for hooks.* — out of scope for this task)
- VM sandbox wrapper for hook validators (§12.4 — complex; v1 trust model)
- Purity ESLint rule (§12.4 — tooling, deferred to separate tooling task)
- Hook spec approval/PR flow (§12.3 — TRD-10 owns proposal; deferred)
- verifier-accuracy corpus (§15.4 — separate QA task)
- Performance/load k6 (§15.5 — separate perf task)
- Compliance evidence suite (§15.6 — TRD-12 audit export task)
