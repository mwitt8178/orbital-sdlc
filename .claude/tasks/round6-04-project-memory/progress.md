# Round 6 Task #4 — Cross-Sprint Project Memory
**[Engineer-Sr · Sonnet · run-round6-04-project-memory]**

## Status: COMPLETE

## TDD Cycle Log

### RED
- Wrote service.test.ts (8 tests), retrieval.test.ts (5 tests), brief-injection.integration.test.ts (6 tests).
- Tests failed: `project_memory_entries` relation did not exist (migration not yet applied).

### GREEN
1. Migration 0023_project_memory.sql — creates 3 tables + indexes. pgvector guarded with `DO $$ EXCEPTION` block so it degrades gracefully when vector extension not installed.
2. Drizzle schema memory.ts — 3 tables, embedding as `text` (drizzle-orm/pg-core has no native vector type).
3. memory/types.ts — Zod enums + input schemas + event payload interfaces.
4. memory/service.ts — DefaultMemoryService (record, get, list, update, archive, supersede). Events use `{ type: 'system', component: 'orchestrator' }` actor + `occurred_at`.
5. memory/retrieval.ts — retrieveTopN with vector probe (disabled when EMBEDDING_PROVIDER=none) + tag-overlap fallback + kind-preference re-ranking.
6. memory/brief-injector.ts — injectMemoryIntoBrief; appends MemoryRetrievedForBrief event.
7. personas/brief.ts — buildBrief made async; MemoryBriefInjection wired as §7 of the brief.
8. trpc/routers/memory.ts + index.ts — tRPC memory router registered.
9. mcp/tools/memory.ts — memoryRecordTool + memorySearchTool with capability gating.
10. orchestration/boot.ts — both MCP tools registered.
11. orchestration/scheduler.ts — await added to buildBrief call.
12. UI: Memory.tsx, MemoryEntryList.tsx, MemoryEntryDetail.tsx, MemoryReferences.tsx.
13. UI routing: App.tsx + SideNav.tsx updated.
14. Skill: memory-curation-protocol.md.

### REFACTOR
- Fixed TS errors: `occurred_at` added to all eventStore.append() calls.
- Fixed actor: `persona` actor → `{ type: 'system', component: 'orchestrator' }`.
- Migration: pgvector `CREATE EXTENSION` wrapped in `DO $$ ... EXCEPTION` for local Postgres installations without the extension.
- Tests: updated NOT_FOUND and AUTH_SCOPE_DENIED assertions to check `OrbitalError.code` property rather than error message string.
- Test for `get() NOT_FOUND`: `toThrow('NOT_FOUND_MEMORY_ENTRY')` → check `err.code`.
- Integration test AC6: `rejects.toThrow('AUTH_SCOPE_DENIED')` → check `err.code`.

## Self-Checks

### DSQL/multi-tenant
- Not applicable (Postgres, not DSQL). Entries are scoped by `project_id` on every query.
- No foreign keys (DSQL constraint honored for future portability).
- No SERIAL (UUIDv7 for all IDs).

### Security
- MCP tools use `bypassScopeCheck: true` with custom `hasMemoryScope()` check.
- memory_write requires explicit `capability:memory_write` in `channel_read` scopes.
- memory_read defaults to true (all agents can search).

### Observability
- All writes log with `logger.info({ entryId, projectId, kind }, ...)`.
- All EventStore appends emit typed events (MemoryEntryRecorded, MemoryEntryCurated, MemoryEntryArchived, MemoryRetrievedForBrief).

### Multi-tenant isolation
- projectId is mandatory on all service methods.
- All DB queries filter by project_id explicitly.
- retrieveTopN scopes to projectId.

## Test Results

| Suite | Tests | Result |
|---|---|---|
| unit/memory/service.test.ts | 14 | PASS |
| unit/memory/retrieval.test.ts | 5 | PASS |
| integration/memory/brief-injection.integration.test.ts | 6 | PASS |
| unit/personas/brief.test.ts | 13 | PASS |

## Deferred
- Embedding provider integration (OpenAI embeddings for vector search) — EMBEDDING_PROVIDER=openai path is scaffolded but not tested with a live provider. Tag fallback is the production path for now.
- Memory page pagination beyond 50 items — current limit is 50, no infinite scroll.

## Risk Tier Assessment
**Medium** — adds new DB tables + migration, new tRPC router, new MCP tools, and modifies buildBrief to be async. All changes are additive; no existing behavior modified except buildBrief (now async, all callers updated).
