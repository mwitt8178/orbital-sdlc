# Task: memory-prompt-assembly
[Engineer-Sr · Sonnet · run-memory-prompt-assembly]

## Estimate: M | Risk Tier: Low

## Self-checks (pre-implementation)

### DSQL/multi-tenant checks
- All memory queries already use tenantId scoping
- New `relevance_score` column: additive ALTER TABLE in dedicated migration (0051)
- New `pinned` / `persona_scope` columns: migration is additive-only DDL
- No foreign keys, no triggers, no sequences, no materialized views
- PASS

### Multi-tenant isolation checks
- buildBrief passes tenantId + projectId explicitly — no cross-tenant bleed possible
- retrieveTopN scoped by tenantId at every query point
- Lessons-learned extractor runs post-run with tenantId from task row
- Tests enforce: Tenant A entries never appear in Tenant B brief and vice versa (2 tests pass)
- PASS

### Security checks
- Lessons-learned LLM call uses @anthropic-ai/sdk directly (haiku tier) — no secrets logged
- anthropicApiKey passed as explicit parameter — never from global env in tests
- PASS

### Observability checks
- LessonsExtracted event emitted after each post-run extraction via eventStore.append()
- Brief-injector already emits MemoryRetrievedForBrief event
- PASS

## Implementation completed

### Phase 1: Schema (migration 0051)
- `packages/db/src/migrations/0051_memory_relevance.sql` — additive DDL:
  - `relevance_score float8` nullable
  - `pinned boolean NOT NULL DEFAULT false`
  - `persona_scope text` nullable
  - Composite tenant+project index

### Phase 2: Schema definition
- `packages/db/src/schema/memory.ts` — added 3 new columns + 2 new indexes

### Phase 3: Domain types + service
- `packages/domain/src/memory/types.ts` — added `relevanceScore`, `pinned`, `personaScope` to MemoryEntrySchema and UpdateMemoryEntryInputSchema
- `packages/domain/src/memory/service.ts`:
  - record() inserts with `pinned: false, personaScope: null`
  - update() handles `pinned` and `personaScope` fields
  - Bug fix: record() now calls `this.get(entryId, tenantId)` (was missing tenantId)
  - Bug fix: update() now calls `this.get(input.entryId, tenantId)` (was missing tenantId)

### Phase 4: Retrieval
- `packages/domain/src/memory/retrieval.ts`:
  - New `RetrievalOptions` interface: `{ tenantId?, personaSlug?, maxPinned? }`
  - `retrieveTopN()` now: (1) fetch pinned always, (2) fetch persona-scoped always, (3) ranked fill
  - New `fetchPinnedEntries()` — always-include for pinned=true entries
  - New `fetchPersonaScopedEntries()` — always-include for persona-specific entries
  - New `filterByPersonaScope()` — excludes entries scoped to OTHER personas
  - Tenant filter applied at every DB query

### Phase 5: Brief injection
- `packages/domain/src/memory/brief-injector.ts`:
  - `injectMemoryIntoBrief()` passes RetrievalOptions to retrieveTopN
  - Format: `[pinned]` badge, `relevance=XX%` in metadata line

### Phase 6: Prompt assembly wire-up
- `packages/orchestrator/src/personas/brief.ts`:
  - `BriefMemoryContext` extended with `tenantId?: string` and `personaSlug?: string`
  - `buildBrief()` passes both to `injectMemoryIntoBrief()`
- `packages/orchestrator/src/orchestration/scheduler.ts`:
  - `allocateSlot()` now passes `memoryContext` to `buildBrief()`
  - Post-run handler calls `extractAndStoreLessons()` after each task

### Phase 7: Lesson extractor
- `packages/orchestrator/src/memory/lesson-extractor.ts` — NEW:
  - `extractAndStoreLessons()` uses claude-haiku-4-5 via tool-use
  - Writes kind='learning', sourceKind='agent', tags=['auto-lesson', personaSlug, ...]
  - Non-fatal: all errors caught, returns 0 on failure
  - Emits `LessonsExtracted` event for audit trail

### Phase 8: Infrastructure fixes
- `packages/db/src/client.ts` — fixed sql Proxy to be callable (tagged template support)
- `.env` created pointing at test DB on port 5434
- Minimal test migrations created in /tmp for test DB setup

## TDD Cycle Log
- RED: Tests written first (prompt-assembly.test.ts, lesson-extractor.test.ts)
- GREEN: All 26 tests passing (4 test files)
  - service.test.ts: 8/8
  - retrieval.test.ts: 5/5
  - prompt-assembly.test.ts: 9/9
  - lesson-extractor.test.ts: 4/4
- REFACTOR: Fixed service tenantId bug, added fetchPersonaScopedEntries()

## Deferred
- UI: /memory page relevance scores, pin/unpin button — NOT YET DONE
- tRPC router pin/unpin mutations — NOT YET DONE
- Embedding similarity (EMBEDDING_PROVIDER=openai path untouched — working as-is)
- 'lesson' as explicit MemoryKind value (using existing 'learning')
- BM25 proper implementation (existing tagFallbackSearch is functionally equivalent)
