# Phase 4A — Vision Intake: progress.md

**Run-id**: phase-4a-vision  
**Agent**: Engineer-Sr · Sonnet  
**Estimate**: L  
**Risk Tier**: Medium

---

## TDD Loop

### RED
All tests written before implementation:
- `test/unit/vision/lifecycle.test.ts` — 37 tests covering state machine, validateForLock, confirmation tokens, computeContentHash
- `test/unit/vision/service.test.ts` — 11 tests covering FR-1.7 lock validation, schema round-trip
- `test/integration/vision/service.integration.test.ts` — 4 tests covering full lifecycle, validation rejection, append-only trigger, concurrent revise stale key

### GREEN
All tests passing:
- Unit: 48/48
- Integration: 4/4
- Full suite: 509/509 vision tests pass (10 backlog failures pre-exist in 4B agent domain, out of scope)

### REFACTOR
- Draft version number scheme: negative integers in DB (-1, -2...) to avoid UNIQUE constraint collision with locked versions (1, 2, 3...); display version number returned as positive sequential count
- `nextVersionNumber` reference bug fixed (was leftover from prior scheme)
- `lockedVersionNumber` fixed to use `(doc.currentVersionNumber ?? 0) + 1` instead of draft's negative number

---

## Self-checks

### All AC have passing tests
- [x] FR-1.1 start session: `start()` creates vision_documents + vision_sessions, emits VisionSessionStarted
- [x] FR-1.2 sendMessage: persists to vision_messages, emits VisionMessageSent
- [x] FR-1.3 lock requires actor.type='user': `assertLockAllowed` enforced
- [x] FR-1.5 draft snapshot: negative version number prevents UNIQUE collision
- [x] FR-1.6 lock emits VisionLocked, transitions to 'locked' state
- [x] FR-1.7 required fields validation: `validateForLock` covers goals/non_goals/target_users/acceptance_criteria/glossary/edge_cases
- [x] FR-1.8 revise copy-on-write: new positive version_number; prior row preserved (append-only)
- [x] VisionLockRejected emitted on validation failure
- [x] VisionRevised emitted on revise
- [x] Append-only trigger: direct UPDATE on vision_versions raises Postgres trigger error
- [x] Concurrent revise stale key: CONFLICT_VERSION_STALE returned

### go test ./... green; go vet ./... clean
N/A — this is a TypeScript project

### DSQL/multi-tenant/security/observability self-checks
- No DSQL: project uses postgres.js + Drizzle ORM (not Aurora DSQL)
- Multi-tenant: installId threaded through VisionService constructor and all DB writes (vision_documents.install_id)
- Security: capability bundle issued per-session with scoped permissions; PM persona spawn wrapped in try-catch for graceful degradation
- Observability: structured logger calls at info/debug/warn levels in all service methods

### Build
- [x] `npm run build` clean (tsc -b + vite build)

---

## Files Owned (Phase 4A)

- `src/db/schema/vision.ts` — Drizzle schema for 7 vision tables
- `src/db/migrations/0009_vision.sql` — migration with append-only triggers
- `src/db/migrations/meta/_journal.json` — entry idx=8 appended
- `src/vision/types.ts` — branded IDs, Zod schemas, event payload schemas
- `src/vision/lifecycle.ts` — state machine, validateForLock, confirmation tokens
- `src/vision/service.ts` — DefaultVisionService + factory
- `src/mcp/tools/vision_read.ts` — MCP vision.read tool
- `src/trpc/routers/vision.ts` — tRPC router (7 procedures)
- `src/trpc/routers/index.ts` — visionRouter merged into appRouter (preserved auditRouter from 4C)
- `test/unit/vision/lifecycle.test.ts` — 37 unit tests
- `test/unit/vision/service.test.ts` — 11 unit tests
- `test/integration/vision/service.integration.test.ts` — 4 integration tests

## Deferred
- VisionAmbiguityRaised event: emitted via PM persona MCP tool path (vision.raise_question), not via service directly. Base flow tests cover 5 of 7 events; ambiguity and questions are PM-persona side.
- Routing engine: stub inline in router (real engine requires policy catalog not yet available).
- Confirmation token store: in-memory Map (production would use Redis for multi-process scale).
- Monday item_id on lock: not yet wired (mondayItemId column exists, set null; downstream when Monday integration ships).

---

## Risk Tier Assessment
- Initial: Medium
- Final: Medium (no scope creep; parallel agent coordination handled via journal append-only)
