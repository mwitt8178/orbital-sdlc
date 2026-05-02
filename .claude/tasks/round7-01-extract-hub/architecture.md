# Round 7-01 — Extract Orchestrator Core Into Deployable Hub Service

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: L

## Why
The current orchestrator runs as a single self-contained process per laptop: Fastify + tRPC + WS + scheduler + spawn + Postgres on Docker. To support multi-operator collaboration we need to extract a "hub mode" — same code, run as a multi-tenant service that multiple local Orbitals connect to. This is task 1 of Round 7 and unblocks everything else in the round.

## Reference
See `/Users/matthewwitt/AI SDLC/orbital/.claude/tasks/round7-multi-operator-federation/architecture.md` for the full Round 7 design.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `orchestration/boot.ts` | existing | Add `ORBITAL_MODE=local|hub` branching. `hub` mode boots Fastify + tRPC + WS + Postgres but skips scheduler/spawn/worktree/MCP-gateway init. `local` mode boots everything (current behaviour). |
| `config/env.ts` | existing | Add `ORBITAL_MODE`, `ORBITAL_HUB_URL` (used by local clients to find their hub), `ORBITAL_HUB_TENANT_ID`. |
| `db/schema/*.ts` | existing | Add `tenant_id` column on every shared table. Tenant scoping is hub-only — when running in `local` mode the column defaults to a single per-install tenant. |
| `db/migrations/0028_hub_tenant_scope.sql` | NEW | Add `tenant_id uuid` column, index, default `'00000000-0000-0000-0000-000000000000'`. |
| `trpc/middleware/tenant.ts` | NEW | tRPC middleware that resolves `tenant_id` from auth header (hub) or static config (local) and injects into context. |
| `trpc/routers/*.ts` | existing | Every query/mutation that reads/writes tenant-scoped data filters by `ctx.tenantId`. Mass refactor: this is the bulk of the work. |
| `index.ts` (orchestrator entrypoint) | existing | Branch on `ORBITAL_MODE`. |
| NEW `Dockerfile.hub` | NEW | Production image for hub mode. |
| NEW `docker-compose.hub.yml` | NEW | Self-host stack: hub + Postgres. |
| NEW `scripts/hub-deploy.sh` | NEW | One-shot deploy script. |

## What "hub mode" specifically excludes
- `scheduler.ts` doesn't tick (no worker spawning)
- `spawn.ts` doesn't try to find the claude binary
- `worktree.ts` doesn't manage worktrees
- `mcp/server.ts` doesn't bind a Unix socket
- The Anthropic driver is not instantiated (no key needed)
- Cost ledger writes are not accepted (operators write to their local ledger)

## Frontend UX
None. This is pure backend split.

But: the hub MUST expose a `/health` endpoint with `{mode: 'hub', version, tenant_count, uptime}` so admin tooling can verify connection. Already exists in some form — extend.

## Acceptance criteria
1. `ORBITAL_MODE=hub npm run dev` boots a server that responds to `/health` with `mode: 'hub'`. No scheduler.tick logs. No claude-binary lookup.
2. `ORBITAL_MODE=local npm run dev` boots exactly as today (zero behaviour change).
3. Migration 0028 adds `tenant_id` to every shared table; existing rows backfilled to the local-default tenant.
4. tRPC tenant middleware injects `ctx.tenantId` from auth header (hub) or static (local). Test: hub-mode request without auth header returns 401.
5. Every tenant-scoped router test passes with explicit tenant scoping (no leakage between tenants).
6. `docker compose -f docker-compose.hub.yml up -d` brings up hub + Postgres on a clean machine.
7. Health endpoint reports correct mode + tenant count.
8. Backwards-compat test: existing local-mode integration tests all pass unchanged.

## Hard-stop grep checks
```
grep -E "ORBITAL_MODE" packages/orchestrator/src/orchestration/boot.ts
grep -E "ctx\.tenantId" packages/orchestrator/src/trpc/routers/ -r | wc -l    # should be ≥ 20
grep -E "tenant_id" packages/orchestrator/src/db/migrations/0028_hub_tenant_scope.sql
ls packages/orchestrator/Dockerfile.hub docker-compose.hub.yml
```

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round7-01-extract-hub]`
