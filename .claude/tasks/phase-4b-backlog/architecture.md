# Phase 4B — Backlog + Sprint + Monday Sync — Architecture

run-id: phase-4b-backlog
Persona: Engineer-Principal · Opus · run-phase-4b-backlog
Status: pre-implementation
TRD: TRD-02 v0.2
Implementation Plan §8 Task 4B (with overrides from the brief: migration index = 0010, NOT 0009 because Phase 4A owns 0009)

---

## 1. Bounded Contexts Touched

### 1.1 OWNED (writes only via this work)
- `backlog` bounded context: `epics`, `stories`, `story_acceptance_criteria`, `sprints`, `sprint_commitments`, `monday_sync_state`
- Backlog service interface (`BacklogService`) and Sprint service interface (`SprintService`)
- Monday integration boundary: `MondayClient`, `MondaySyncService`, webhook receiver
- tRPC `backlog.*` and `sprint.*` namespaces
- Migration `0010_backlog.sql` (this run; Phase 4A is migration `0009`, Phase 4C is `0011+`)

### 1.2 READ ONLY (no writes from this work)
- `tasks`, `task_dependencies` (TRD-04 owns; we INSERT new task rows but use the schema definition from `db/schema/orchestration.ts`; this is consistent with the existing pattern in the codebase: TRD-02 §16 explicitly authorizes TRD-02 to insert task rows during decomposition)
- `personas` (read via `PersonaLoader` to resolve persona-of-record)
- `agent_workers` (read via PauseController to wait on drain)
- `events` (write only via `EventStore.append`; never direct insert)
- `defects` (TRD-11 owns; not present in this phase — no read or write)

### 1.3 INTEGRATION SURFACES
- `Scheduler` (TRD-04, already implemented in `src/orchestration/scheduler.ts`) — call `addSprint` / `removeSprint`
- `PauseController` (already implemented) — delegate `pause` / `resume`
- `BlockerService` (already implemented; `setOnRoute` callback or constructor-injected `onRoute` option) — wire `Scheduler.addTask`-like synthetic resolver task creation. Since the existing `Scheduler` interface does not expose `addTask`, we instead persist a real task row (`tasks` insert) for the resolver and the next `Scheduler.tick()` picks it up. This is consistent with `BlockerService` Phase 3A's pattern of routing to a synthetic `resolverTaskId` UUID — we now make that UUID a real task row.
- Monday HTTPS API at `https://api.monday.com/v2` (real network calls in production; mocked at the network boundary via `undici.MockAgent` in tests)

---

## 2. Aggregate Boundaries (within OWNED context)

| Aggregate | Root entity | Member entities | Invariants |
|---|---|---|---|
| Epic | `epics` | — | one `vision_version_id`; priority dense within an install |
| Story | `stories` | `story_acceptance_criteria` | every story belongs to exactly one `epic_id`; status transitions follow TRD-02 §7.1; AC ordinals unique per story |
| Sprint | `sprints` | `sprint_commitments` (1:1) | status transitions follow TRD-02 §7.2; `sequence` monotonic within install; `concurrencyShare > 0`; `priorityClass` ∈ {critical,standard,background} |
| MondaySyncState | `monday_sync_state` | — | (aggregate_type, aggregate_id) → unique mapping; `monday_id` and `last_seen_item_ids` updated atomically with sync |

State mutations on stories/sprints take an advisory lock (`pg_advisory_xact_lock(hashtext('story:'||id))`) inside the transaction that emits the event, per TRD-02 §8.1. The status update + event append share one txn.

---

## 3. Event Flow

### 3.1 Emitted (this work)
- `EpicCreated` (aggregate_type=epic, payload per TRD-02 §5.1)
- `StoryCreated` (aggregate_type=story)
- `StoryRefined` (aggregate_type=story)
- `StoryEstimated` (aggregate_type=story)
- `StoryStatusChanged` (aggregate_type=story)
- `SprintCreated` (aggregate_type=sprint)
- `SprintStarted` (aggregate_type=sprint)
- `SprintPaused` (aggregate_type=sprint) — also `OrchestrationPauseDrained` is emitted by PauseController; we additionally emit `SprintPaused` at the sprint-state level
- `SprintResumed` (aggregate_type=sprint)
- `SprintCompleted` (aggregate_type=sprint)
- `BacklogReprioritized` (aggregate_type ∈ {epic,story}) — emitted on reorder
- `MondaySyncCompleted` (aggregate_type=sprint as proxy for the install scope; payload identifies `direction` ∈ {push,pull,webhook})

All events go through `EventStore.append`. Never `db.insert(events)`.

### 3.2 Consumed (this work)
- `VisionLocked` (TRD-01) — Phase 4A emits. We will NOT subscribe in this phase (decomposition handler is out of scope per the brief: "epic CRUD, story CRUD"). The `vision_version_id` reference is a foreign-key-style nullable column on `epics`; population is the caller's job (UI or future decomposition flow).
- We do NOT subscribe to `TaskCreated` / `TaskCompleted` / `DefectCreated` / `CeremonyOutputWritten` in this phase. Those are downstream signals consumed by future phases (UAT, ceremony materializer). Keeping the consumer matrix minimal in 4B avoids tripping over Phase 4A and Phase 4C work in parallel.

### 3.3 Webhook → Internal mutation path
Monday webhook `POST /api/v1/webhooks/monday` → signature verify → normalize body → invoke `MondaySyncService.handleWebhookPayload` → routes to status-change handler or item-update handler → uses internal mutation path (advisory lock, EventStore append) — never a raw SQL update.

---

## 4. IAM Diff

No IAM changes in this phase. Reasons:
- All tRPC procedures use `publicProcedure` per existing pattern (auth happens at Fastify middleware layer; this is unchanged)
- The webhook endpoint authenticates by HMAC of `MONDAY_WEBHOOK_SECRET`, not by an Orbital capability
- No new keychain accounts (Monday token reuses the existing `MONDAY_API_TOKEN` env var with optional keychain fallback via the existing keychain wrapper)
- No new persona capability scopes — `board_read` and `board_mutate` already exist in TRD-06

We surface no risk requiring a Security Review (per brief: this work is XL but routine schema + integration; no auth flow changes).

---

## 5. DSQL Schema Diff (Postgres in this codebase, not DSQL — the install runs vanilla Postgres 16 per docker-compose)

### 5.1 New tables (migration 0010_backlog.sql)
- `epics` — 9 columns + 2 indexes
- `stories` — 14 columns + 3 indexes
- `story_acceptance_criteria` — 6 columns + 1 unique index, 1 secondary index
- `sprints` — 18 columns + 2 indexes
- `sprint_commitments` — 9 columns + 1 secondary index (sprintId unique)
- `monday_sync_state` — 11 columns + 2 indexes

### 5.2 Patterns followed (DSQL hard-no list, even though this is Postgres)
- No foreign keys to cross-context tables (epics → vision_versions has no physical FK; the column is conceptually FK)
- WITHIN-context FKs are allowed: `stories.epic_id → epics.epic_id`, `story_acceptance_criteria.story_id → stories.story_id ON DELETE CASCADE` — these are within the backlog context and the existing codebase pattern (e.g. comms-workflow.ts) uses real FKs within bounded contexts. Acceptable.
- No triggers
- No SERIAL: all ids are `uuid` (UUIDv7 generated in app via `uuidv7` package)
- No materialized views
- No stored procs / extensions
- All mutations are short transactions (<5 min)
- DDL is in migration only; no DDL in DML transactions
- `defaultNow()` for `created_at` is acceptable (matches all existing schemas in the codebase)

### 5.3 Migrations
- File: `src/db/migrations/0010_backlog.sql`
- Journal entry: APPEND `{idx: 8, version: "7", when: <now>, tag: "0010_backlog", breakpoints: true}` to `_journal.json` (do NOT overwrite earlier entries; do NOT bump idx of existing entries — Phase 4A and Phase 4C will append their own with their own idx)
- IMPORTANT: Phase 4A owns 0009. We are 0010. Phase 4C is 0011 (or AFTER ours per brief). Journal entries: idx 0..7 = existing; idx 8 = ours. Phase 4A and Phase 4C must additively merge their own entries; conflict resolution at sprint reconciliation, NOT at parallel-fork time.
- Idempotent (CREATE TABLE IF NOT EXISTS, CREATE INDEX IF NOT EXISTS) per existing migration patterns

---

## 6. Blast Radius

### 6.1 Code-level
- New files: 9 source files under `src/backlog/`; 1 schema file; 1 migration; 1 tRPC router; 5 test files
- Modified files (additive merge only):
  - `src/trpc/routers/index.ts` — append `backlog: backlogRouter`
  - `src/index.ts` — single line to register webhook plugin (per brief)
  - `src/db/migrations/meta/_journal.json` — append entry idx=8

### 6.2 Runtime
- New tables created at migration time. Existing data unaffected.
- New webhook route accepts traffic but does not affect existing routes
- New tRPC namespace adds queries/mutations; does not change existing namespaces
- `Scheduler.addSprint` is already exposed; we simply call it from a new caller. No change to scheduler internals.
- BlockerService callback wiring: SprintService.start initializes a callback that, when fired, persists a real task row for the resolver. This is a NEW behaviour relative to the Phase 3A best-effort path. Risk: a stale callback firing after sprint completion could create orphan tasks. Mitigation: SprintService.start binds the callback ONCE at sprint start; SprintService.complete unbinds. The callback consults `sprints.status` before persisting the task and skips if not active.

### 6.3 Network egress
- New egress to `api.monday.com` (port 443). Production must whitelist if egress controls exist. Already noted in TRD-02 §16.
- No new internal RPC dependencies.

### 6.4 Test surface
- All tests run against real Postgres (per CLAUDE.md no-mocks rule)
- Monday HTTP layer is mocked via undici MockAgent at the boundary
- Webhook tests use real HMAC over real bodies

---

## 7. Rollback Strategy

### 7.1 Migration
- The migration is idempotent (`IF NOT EXISTS`). Re-running on a populated DB is a no-op.
- Rollback: `DROP TABLE IF EXISTS monday_sync_state, sprint_commitments, sprints, story_acceptance_criteria, stories, epics CASCADE;` plus delete journal entry idx=8. Document this in a `down` script if/when migrations gain rollback support; currently the codebase does not track down migrations.
- Practical rollback path: zero new data accumulated within a few minutes of deploy → drop tables; >1 hour of data → freeze migration, leave tables, disable code paths via feature flag (no flag implemented in this phase; would require a new env var if we needed to roll back live).

### 7.2 Code rollback
- All new code is additive. Reverting the commit removes the new tRPC namespace and the webhook route.
- The single line in `index.ts` (`registerBacklogWebhook(app, ...)`) and the single line in `trpc/routers/index.ts` (`backlog: backlogRouter`) revert cleanly.
- Migration tables remain; safe to leave or drop manually.

### 7.3 Monday integration
- If Monday API behavior changes mid-flight, the `MondayClient` throws `INTEGRATION_MONDAY_DOWN` on 5xx and `RATE_LIMIT_MONDAY_API` on 429. Local mutations continue to commit; the sync queue accumulates and drains on recovery.
- If Monday auth fails (`INTEGRATION_MONDAY_AUTH`), the sync service pauses pushes for that aggregate. The webhook continues to verify HMAC independently.
- A bad webhook secret rotation: incoming webhooks return 401; Monday will retry. Mitigation: rotate via `MONDAY_WEBHOOK_SECRET` env var; service restart picks up new value. Document this in an ADR if/when rotation is automated.

---

## 8. Confidence and Risk

- **Risk Tier**: High (multi-table schema, external integration, scheduler integration, parallel work with Phase 4A and Phase 4C).
- **Confidence**: 96. Rationale: TRD-02 is detailed; all integration surfaces (Scheduler, PauseController, EventStore) are stable and tested; the parallel work has clean boundaries (different migration indices, different module dirs, different schema files). Risk drivers I cannot eliminate: (a) Monday API shape changes between TRD authorship and now — mitigated by mocking at network boundary and verifying GraphQL shape matches the v2 docs at integration test time; (b) flakiness of `Scheduler.addSprint` integration test under parallel test pressure — mitigated by polling and isolated sprintId/installId per test.
- **Stateful-resource changes**: New Postgres tables only. No DSQL cluster, KMS key, user pool, or S3 bucket changes. No surface required.
- **Cross-family review**: Will rely on parent orchestrator to dispatch Code Review on a non-Opus family per Engineer-Principal hard rules. Not blocking implementation.

---

## 9. Implementation order (TDD inside)

1. Schema + migration (0010_backlog.sql) + journal append
2. types.ts (shared TS types)
3. service.ts (BacklogService) — write tests, then code
4. sprint-service.ts (SprintService) — tests, then code
5. monday-client.ts — tests with undici MockAgent, then code
6. monday-sync.ts — tests, then code
7. webhook.ts — signature validation tests, then code
8. trpc/routers/backlog.ts — wire + smoke tests
9. Wire backlogRouter into appRouter; wire registerBacklogWebhook into index.ts
10. Integration test: end-to-end sprint lifecycle with real DB and HTTP mock at boundary

---

## 10. Open decisions (resolved during planning)

| Decision | Resolution |
|---|---|
| Where does the BlockerService → Scheduler resolver wiring happen? | SprintService.start installs the callback by mutating BlockerService through `setOnRoute` (we will add this method to BlockerService since the existing `onRoute` is constructor-only). The callback persists a real task row keyed off the raising task's sprint and the resolver role's persona. |
| Do we sync sprints to Monday as board groups in this phase? | YES at create time (best-effort; failure is non-fatal and queued). Listed in the brief Done criteria. |
| Do we fire VisionLocked-based decomposition? | NO. Out of scope per brief. The columns are defined; population is via direct CRUD or future hooks. |
| Idempotency keys on tRPC mutations? | Defer; not on the brief Done list. |
| `setOnRoute` API change to BlockerService — minimal-touch additive? | YES: add `setOnRoute(callback)` method that mutates the private field. Tests pass without it; we only add. No removal of existing `onRoute` constructor option. |

---

## 11. Persona evidence

`[Engineer-Principal · Opus · run-phase-4b-backlog]`

architecture.md finalized; proceeding to TDD implementation per §9 order.
