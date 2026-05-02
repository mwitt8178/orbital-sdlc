# Phase 2B — MCP Gateway Progress

run-id: 2b-mcp-gateway-sonnet-01

## Status: IN PROGRESS

## Self-checks

### DSQL/multi-tenant/security/observability
- Not a DSQL project — uses local Postgres 16 via Docker.
- Multi-tenant: N/A (single-install local product).
- Security: CapabilityBundle verified at connect-time via CapabilityAuthority.verify(); validateToolCall enforces per-call scope; CapabilityDenied events written for all denials.
- Observability: OTel spans per tool call via @opentelemetry/api trace.getTracer(); trace_id propagated from bundle through all events.

### Phase boundaries respected
- Do NOT touch: db/schema/personas.ts, db/schema/routing.ts, migrations 0003/0004, personas/*, routing/*, config/routing-policy.default.ts
- Own ONLY: db/schema/worker-tables.ts, db/migrations/0005_workers.sql, mcp/*, test/unit/mcp/*, test/integration/mcp/*

### TDD Cycle
- RED: write failing tests first
- GREEN: implement to pass
- REFACTOR: clean up

## Deferred
- worker.heartbeat task_id FK to tasks table (Phase 2C owns tasks; we store task_id as uuid but no FK constraint)
- inbox.subscribe MCP tool (Phase 3A owns comms substrate)
- channel.post MCP tool (Phase 3A)
- git.sign_commit MCP tool (Phase 6C)
- Bloom filter backed revocation cache (in-memory check against DB on every verify; cache is Phase 2C optimization)
- Key chain verification step C from TRD-06 §6.2.1 (sub-key chain check delegated to CapabilityAuthority.verify which wraps bundle.ts verifyBundle — Phase 1B shipped this)

## Files to create
1. db/schema/worker-tables.ts
2. db/migrations/0005_workers.sql
3. db/migrations/meta/_journal.json (append entry)
4. mcp/protocol.ts
5. mcp/registry.ts
6. mcp/router.ts
7. mcp/server.ts
8. mcp/middleware/audit.ts
9. mcp/middleware/tracing.ts
10. mcp/tools/worker_heartbeat.ts
11. mcp/tools/task_complete.ts
12. mcp/tools/task_fail.ts
13. mcp/tools/task_request_help.ts
14. test/unit/mcp/registry.test.ts
15. test/unit/mcp/router.test.ts
16. test/unit/mcp/tools.test.ts
17. test/integration/mcp/gateway.integration.test.ts
