# Phase 5B — Retro Service: Architecture

**Run:** Engineer-Principal · Opus · run-5B
**Status:** Pre-implementation
**Confidence:** 96 (rationale: TRD-10 is comprehensive; existing Phase 0–4 patterns provide direct templates for service shape, schema layout, event emission, tRPC routers and integration tests; novel area is the agent-org Git repo + version pin column extension which is bounded and additive)

---

## 1. Bounded contexts touched

| Context | Action | Rationale |
|---|---|---|
| `retros` (NEW) | OWN — service, schemas, migration, router, tests | Phase 5B charter |
| `system_versions` (NEW within retros bounded context) | OWN — version + diff tables | TRD-10 §4.5 hosts these here even though they cross subsystems |
| `backlog.sprint_commitments` | EXTEND — additive `system_version_id` column via 0012 | Phase 5B brief explicitly authorizes the additive cross-schema migration; it owns the retro-side pin and is the only column added |
| `audit.events` | READ via `EventStore.query()`; APPEND via `EventStore.append()` | All retro-emitted events are written through EventStore |
| `orchestration.tasks`, `orchestration.retry_attempts`, `orchestration.escalations` | READ-ONLY for sprint metrics | Per Phase 5B brief — read-only mining |
| `routing.routing_decisions`, `routing.cost_accounting` | READ-ONLY for sprint cost mining | Per Phase 5B brief — read-only mining |
| `personas.*` | READ-ONLY via `PersonaLoader` for retro-analyst lookup | Per Phase 5B brief |
| `capabilities.*` | WRITE via `CapabilityAuthority.issue()` for analyst capability bundle | Standard CBAC issuance |

**No touched contexts:** `uat`, `db/schema/uat.ts`, `migration 0011_uat`. Phase 5A is owned by parallel agent.

---

## 2. Aggregate boundaries

The `retros` bounded context owns these aggregate roots:

- **RetroReport** — root of a sprint analysis run; children: RetroAnalysis (per-metric), RetroProposal (per layer-level proposal)
- **RetroProposal** — has child RetroProposalLayer rows (1..N, exactly one with `is_dominant=true`)
- **SystemVersion** — root of a versioned agent-org bundle; children: SystemVersionDiff rows (per file in the diff)
- **RetroOutcome** — singleton-per-(proposal, version); represents the comparison window for a shipped change

Cross-aggregate references (system_version_id from sprint_commitments) are **nullable uuid** fields without physical FKs, consistent with Phase 0/1 cross-context reconciliation pattern (TRD-04 §4.1).

**Within-context FKs** (kept and enforced):
- `retro_analyses.retro_report_id → retro_reports.retro_report_id`
- `retro_proposals.retro_report_id → retro_reports.retro_report_id`
- `retro_proposal_layers.retro_proposal_id → retro_proposals.retro_proposal_id` ON DELETE CASCADE
- `system_version_diffs.system_version_id → system_versions.system_version_id`
- `system_version_diffs.retro_proposal_id → retro_proposals.retro_proposal_id` (nullable)
- `retro_outcomes.retro_proposal_id → retro_proposals.retro_proposal_id`
- `retro_outcomes.system_version_id → system_versions.system_version_id`

---

## 3. Event flow

```
SprintCompleted                          (consumed; emitted by sprint-service)
   │
   ▼
RetroService.onSprintCompleted(sprintId)
   │  (subscribes via EventStore.subscribe with cursor)
   │
   ▼
RetroService.analyze(sprintId)
   │
   ├──► insert retro_reports row (status='analyzing')
   ├──► EventStore.append RetroAnalysisStarted
   │
   ├──► CapabilityAuthority.issue({ scopes: { board_read: ['*'], channel_read: ['#sprint-{sprintId}'], files_write: [] }, persona_id: 'retro-analyst' })
   │       (SoD check at issue-time asserts no files_write)
   │
   ├──► spawn retro-analyst persona OR (test path) call RetroService.synthesizeProposalForTest()
   │       Analyst reads sprint events + cost + routing decisions + hook rejections + verifier failures + ceremony outputs + defect rates
   │
   ├──► for each generated proposal:
   │     - validate against ProposalSchema
   │     - insert retro_proposals + retro_proposal_layers
   │     - EventStore.append RetroProposed
   │
   ├──► update retro_reports.status='ready'
   └──► EventStore.append RetroReportGenerated

[ user reviews on UI ]
   │
   ▼
ProposalService.approve(proposalId, rationale, userId)
   │
   ├──► assert proposal.status='pending'
   ├──► AgentOrgRepo.commit(targetPath, content, message, author)
   │       (real git commit in ~/.orbital/agent-org/)
   │       returns commit hash
   ├──► insert system_versions row { git_sha=hash, version_number=semver-bump }
   ├──► insert system_version_diffs row(s)
   ├──► update retro_proposals { status='merged', merged_system_version_id, pr_ref=branchName, decided_by, decided_at, decision_rationale }
   ├──► insert retro_outcomes row (open window, expected_pct_points, baseline_value)
   ├──► EventStore.append RetroApproved
   └──► EventStore.append SystemVersionShipped (parent_event_id = RetroApproved.event_id)

ProposalService.reject(proposalId, rationale, userId)
   ├──► update retro_proposals { status='rejected', ... }
   └──► EventStore.append RetroRejected

ProposalService.defer(proposalId, rationale, userId)
   ├──► update retro_proposals { status='deferred', ... }
   └──► EventStore.append RetroDeferred

ProposalService.rollback(systemVersionId, rationale, userId)
   ├──► AgentOrgRepo.reset(parentCommitHash)  OR  AgentOrgRepo.revert(versionGitSha)
   ├──► insert new system_versions row { is_rollback=true, rolled_back_version_id }
   ├──► update originating retro_proposals.status='rolled_back'
   ├──► EventStore.append RetroRolledBack
   └──► EventStore.append SystemVersionShipped (the rollback is a new shipped version)

[ next sprint completes ]
   │
   ▼
OutcomeTracker.onSprintCompleted(sprintId)
   ├──► find prior sprint's pinned system_version_id
   ├──► find open retro_outcomes for that version
   ├──► compare actual_metric_delta vs expected_metric_delta
   ├──► update retro_outcomes { actual_pct_points, matched_expectation, computed_at }
   └──► EventStore.append OutcomeRecorded
```

---

## 4. IAM diff (capabilities)

The retro-analyst capability bundle issued at `RetroService.analyze()` time:

```json
{
  "persona_id": "retro-analyst",
  "scopes": {
    "files_read": ["**"],          // can read for analysis (audit-log queries)
    "files_write": [],             // EMPTY — asserted at issue-time via SoD check
    "board_read": ["*"],           // per Phase 5B brief
    "board_mutate": [],
    "channel_read": ["#sprint-{sprintId}"], // narrow scope
    "channel_post": [],            // analyst does not chat back
    "secrets": [],
    "network_egress": ["api.anthropic.com"],
    "spawn_subagent": false,
    "git_commit": null,            // approval flows mint THEIR OWN commit; analyst NEVER commits
    "ceremony_role": ["observer"]
  },
  "ttl_ms": 600000  // 10 minutes for analysis
}
```

**SoD assertion (compile-time + issue-time):** `scopes.files_write.length === 0`. We extend `capabilities/sod.ts:checkIssue` with rule `RETRO_ANALYST_NO_FILES_WRITE`: if `persona_id === 'retro-analyst'` and `scopes.files_write` is non-empty, reject with `AUTH_SOD_VIOLATION`. This is enforced via the existing `checkIssue()` extension point.

Approval-time `ProposalService.approve()` is NOT a capability-protected operation in this phase — it is a privileged tRPC procedure invoked by a real user. The Git commit it performs is via the orchestrator's own filesystem access to `~/.orbital/agent-org/`, NOT via a worker-issued capability.

---

## 5. DSQL / Postgres schema diff

### New tables (in `public` schema, like existing migrations)

1. **`retro_reports`** — top-level retro per sprint analysis run.
2. **`retro_analyses`** — per-metric structured analysis.
3. **`retro_proposals`** — proposal lifecycle.
4. **`retro_proposal_layers`** — N rows per proposal; exactly one `is_dominant=true`.
5. **`system_versions`** — versioned agent-org bundle metadata; tracks Git commits.
6. **`system_version_diffs`** — per-file diff record per version.
7. **`retro_outcomes`** — predicted-vs-actual comparison record.

### Additive column on existing table

8. **`sprint_commitments`** — ADD COLUMN `system_version_id uuid` NULL.
   - Idempotent: `ALTER TABLE sprint_commitments ADD COLUMN IF NOT EXISTS system_version_id uuid;`
   - Justified by Phase 5B brief option 2: "add a system_version_id column via your migration".
   - Nullable so existing Phase 4B-created rows do not break.
   - No FK to `system_versions` (cross-schema soft reference per existing convention).
   - This is **additive only**: no changes to existing columns, no changes to existing constraints, no data migration needed.

### Constraints / indices

- All `retro_*` tables PK is uuid (UUIDv7 generated app-side).
- Within-context FKs as listed in §2.
- Unique indices: `retro_reports(sprint_id, analysis_run_seq)`, `retro_proposals(proposal_code)`, `system_versions(version_number)`, `system_versions(git_tag)`.
- Status indices for query patterns from tRPC list endpoints.
- No triggers (state machines enforced in app layer per existing convention).

### Migrations

- `0012_retros.sql` — DDL for all 7 new tables + the ALTER for sprint_commitments.
- Append to `_journal.json` as entry idx=10, tag `0012_retros`. Existing entries 0..9 are untouched.

---

## 6. Blast radius

- **High blast radius (avoided):** No changes to `audit.events` table, no changes to existing schemas, no triggers added, no changes to any existing service.
- **Medium blast radius (intentional):** `sprint_commitments.system_version_id` additive column. Phase 4B sprint-service does not currently set this; it remains NULL for existing rows. Future sprint creation MAY set it via a non-blocking call to `RetroService.recordVersionPin()` — but Phase 5B does not modify the sprint-service to require this. Phase 4B owners can opt-in later.
- **Low blast radius:** New `retros/` module is fully isolated. New tRPC `retrosRouter` is additive merge into appRouter. New persona `retro-analyst` already exists in Phase 2A library; only the loader behaviour at boot is unchanged.

**Failure modes considered:**
- Git operations failing (corrupt repo, file permission errors): wrapped in try/catch, surfaced as `OrbitalError('INTEGRATION_GIT_CONFLICT', ...)`.
- agent-org repo missing on first run: `AgentOrgRepo.init()` runs `git init` + `git commit --allow-empty -m "initial"`.
- Concurrent retro runs for same sprint: unique index on `(sprint_id, analysis_run_seq)` guards.
- Test isolation: each test uses `os.tmpdir()` + unique dirname for `ORBITAL_HOME`; `afterEach` cleans up.

---

## 7. Rollback strategy

If Phase 5B implementation needs to be backed out:

1. **Code rollback:** revert all `packages/orchestrator/src/retros/**` files, the migration file, the journal entry, the schema file, the tRPC router file, and the appRouter wiring change.
2. **DB rollback:** the migration is idempotent (`CREATE TABLE IF NOT EXISTS`, `ADD COLUMN IF NOT EXISTS`). To reverse:
   ```sql
   DROP TABLE IF EXISTS retro_outcomes, system_version_diffs, system_versions,
                        retro_proposal_layers, retro_proposals, retro_analyses, retro_reports CASCADE;
   ALTER TABLE sprint_commitments DROP COLUMN IF EXISTS system_version_id;
   DELETE FROM drizzle_migrations WHERE tag = '0012_retros';
   ```
3. **Filesystem rollback:** `rm -rf ~/.orbital/agent-org` (user data; only if user opts in).
4. **Event-log impact:** previously emitted `RetroProposed`, `RetroApproved`, `SystemVersionShipped`, `OutcomeRecorded` events remain in `audit.events` (append-only). They are inert without the retros tables and the service code.

The forward-only `audit.events` table means the rollback is a pure code+schema operation; we do not need to mutate the event log.

---

## 8. Test strategy

**Unit tests (real Postgres, isolated per-test data; no module-level mocks):**
- `service.test.ts` — onSprintCompleted triggers analysis; analyze() inserts report + emits RetroAnalysisStarted; synthesizeProposalForTest() generates valid proposals; idempotency on repeat call.
- `proposals.test.ts` — approve transitions pending→merged, emits both events, inserts version row, opens outcome window; reject only emits RetroRejected; defer only emits RetroDeferred; rollback creates new version row; invalid state transitions error.
- `agent-org.test.ts` — init creates real git repo; commit produces a real commit hash; readFile reflects last commit; reset reverts; log returns history; uses os.tmpdir() with unique dirname per test.
- `outcomes.test.ts` — onSprintCompleted compares delta; matched_expectation true when within tolerance; false otherwise; emits OutcomeRecorded.

**Integration test (lifecycle.integration.test.ts):**
1. Insert real sprint + commitment in Postgres.
2. Append SprintCompleted via EventStore.
3. Synchronously call RetroService.onSprintCompleted (no scheduler racing).
4. Assert retro_reports row exists with status='ready'.
5. Assert ≥1 proposal row exists with valid layer and target_path.
6. Call ProposalService.approve(proposalId, rationale, userId).
7. Read agent-org git log via AgentOrgRepo.log() — assert commit exists with the proposal's title.
8. Query audit.events — assert SystemVersionShipped event exists with the same git_sha.

All tests share a unique `ORBITAL_HOME=os.tmpdir()/orbital-retros-{pid}-{rand}/` and clean up in `afterEach`.

---

## 9. Confidence rationale

- TRD-10 is exhaustive (1097 lines): tables, events, schemas, state machines, error codes, performance targets all documented at implementer-precision.
- Existing Phase 4A/4B vision-service and sprint-service provide near-identical patterns for service shape (constructor injection, EventStore.append discipline, OrbitalError catalog, status state machines).
- `simple-git` is NOT a dependency; we shell out to `git` via `node:child_process.execFileSync` per the Phase 5B brief — keeps the dep graph small and matches the existing pattern (no `simple-git` is currently in package.json).
- Risks enumerated in §6 with mitigations.
- The only architectural novelty is the agent-org Git repo. This is a thin wrapper on `child_process` with a clear interface boundary.

Confidence: **96/100**. Threshold for High/Critical risk is 95; we exceed.

**Risk classification: High** (introduces a new bounded context, new event types, cross-schema additive migration, security-critical capability boundary for analyst). Cross-family review will be requested via the orchestrator post-completion.
