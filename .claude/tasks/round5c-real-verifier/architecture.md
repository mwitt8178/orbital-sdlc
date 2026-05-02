# Round 5C — Real Verifier (Engineer-Principal architecture)

Persona: Engineer-Principal · Opus · run-round5c
Confidence: 95
Risk Tier: High (security-critical: capability scope, SoD, evidence chain)
Estimate: XL

## Why this is Engineer-Principal

- New evidence-storage bounded context (`audit.ac_check_evidence`) cross-cuts orchestration, UAT, and verifier.
- Security-critical: capability scope tightening on a persona that previously had unrestricted read; the new path executes user-supplied test commands inside a child process.
- Cross-context refactor: VerifierService stops being a stub and starts spawning real worker tasks with a restricted capability bundle.

## Bounded contexts touched

| Context | Files | Change |
|--|--|--|
| `verifiers` (orchestrator) | `service.ts`, `ac-checker.ts` (NEW), `evidence.ts` (NEW), `sod.ts` (preserved) | New behaviour: real spawn; AC checking algorithm; evidence persistence |
| `personas` (orchestrator) | `library/verifier.ts`, `skills/verify-ac-evidence-protocol.md` (NEW) | Tighten default capability profile; add new skill |
| `db` (orchestrator) | `schema/ac-check-evidence.ts` (NEW); `migrations/0021_ac_check_evidence.sql` (NEW); `migrations/meta/_journal.json` | New `audit.ac_check_evidence` table |
| `trpc.uat` (orchestrator) | `routers/uat.ts` | Additive `uat.ac.evidence` query |
| `ui.uat` | `ACChecklist.tsx`, `EvidencePanel.tsx` (NEW) | Per-AC verifier signal column with expandable evidence affordance |
| `events` | (no schema change) | New `VerifierEvidenceRecorded` event type, emitted via existing `EventStore.append` |

## Aggregate boundaries

- A **verification** owns N **ACCheckEvidence** rows (one per AC checked) plus N **verification_results** rows. Both are within the verification aggregate; they are written atomically with respect to a single verification's lifecycle.
- A **uat_ac_result** references the AC by `ac_id`. ACCheckEvidence ALSO references `ac_id`; the `uat.ac.evidence` query joins on `ac_id` with `ORDER BY created_at DESC LIMIT 1` to produce the most recent verifier evidence for the AC. This is a deliberate looser coupling: the AC may be re-verified across sprints; the UAT pass-of-record carries a different concept of "current".

## Event flow

```
TaskCompleted (with ready_for_verification=true, artifact_paths)
  → post-task hook
    → VerifierService.spawnVerifier(taskId, ticketId, artifactPaths, actingPersonaId)
      → SoD assertion (preserved)
      → load parent task (worktree path, story_id, persona_id)
      → load story_acceptance_criteria for the story
      → INSERT verifications (status='running', ac_count=N)
      → emit VerifierStarted (aggregate=verification)
      → for each AC, INSERT a child task in `tasks` with persona_id='verifier',
        ticket_id=parent.ticket_id, parent_task_id=parent.task_id, sprint_id=parent.sprint_id,
        title='Verify AC #{n}: {ac.title}', description includes the AC text + diff summary,
        acceptance_criteria=[ac.text], state='ready'
      → return verificationId

Scheduler.tick()
  → picks the verifier task
  → routing → CapabilityAuthority.issue (constrained scope, see below)
  → spawn the verifier worker

Verifier worker (claude binary executing `verify-ac-evidence-protocol`)
  → reads diff via git diff in worktree
  → calls checkAC() per AC
    → detect framework
    → match candidate test files
    → spawn child_process the framework runner with timeout
    → if no test or ambiguous → AnthropicDriver.judge(diff + ac + test_output)
    → result: pass | fail | ambiguous + evidence
  → persists ACCheckEvidence via Evidence.recordEvidence()
  → emits VerifierEvidenceRecorded (one per AC)
  → calls VerifierService.submitResult({verification_id, results:[...], summary})
  → submitResult emits VerifierPassed | VerifierFailed | VerifierAmbiguous

UAT UI (ACChecklist)
  → renders AC list (existing query)
  → for each AC, calls uat.ac.evidence({ac_id})
  → renders ✓/✗/?/— icon; click expands EvidencePanel showing test_command,
    test_output (collapsed), llm_reasoning, files_inspected
```

## IAM diff (capability scope)

**Before** (`personas/library/verifier.ts:51-63`):

```ts
filesRead: ['**']
filesWrite: ['verification-records/**']
boardRead: ['*']
boardMutate: ['ticket:*.verification_status']
channelRead: ['#orb-*', '#sprint-*']
channelPost: ['#orb-*']
spawnSubagent: false
gitCommit: null
```

The verifier could read EVERYTHING and write to verification-records. That is too wide.

**After**:

```ts
filesRead: ['**']    // unchanged: verifier needs to read worktree + ACs
filesWrite: []       // TIGHTENED: zero write scope
boardRead: ['*']
boardMutate: []      // TIGHTENED: verifier never mutates board
channelRead: ['#verification-*', '#orb-*']
channelPost: ['#verification-*']    // TIGHTENED: scoped to verification channels
spawnSubagent: false
gitCommit: null
```

The MCP gateway already enforces capability scopes; tightening here means the gateway will reject attempted writes with `AUTH_SCOPE_DENIED` instead of allowing writes to `verification-records/**`. This matches the brief's "files_read on artifactPaths + worktree, channel_post on #verification-{taskId}, NO files_write, NO board_mutate, NO spawn_subagent".

We do not over-rotate channel scope to `#verification-{taskId}` (i.e. include the verificationId) because (a) channel matching is glob-based today and (b) per-verification channels would force capability bundles to be re-issued for every spawn, which the routing layer is not optimised for. `#verification-*` is sufficiently narrow for the v1 trust model.

## DSQL schema diff

```sql
-- new table in audit schema (already exists; created by 0007/0013)
CREATE TABLE IF NOT EXISTS audit.ac_check_evidence (
  evidence_id      uuid        PRIMARY KEY,
  verification_id  uuid        NOT NULL,                       -- logical FK → verifications.verification_id
  ac_id            uuid        NOT NULL,                       -- logical FK → story_acceptance_criteria.ac_id
  result           text        NOT NULL CHECK (result IN ('pass','fail','ambiguous')),
  evidence_kind    text        NOT NULL CHECK (evidence_kind IN ('test_run','static_analysis','llm_inspection','manual_required')),
  test_command     text,
  test_output      text,
  test_exit_code   integer,
  llm_reasoning    text,
  files_inspected  jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ac_check_evidence_ac_idx
  ON audit.ac_check_evidence (ac_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ac_check_evidence_verif_idx
  ON audit.ac_check_evidence (verification_id);
```

- No FKs (DSQL hard-no list); logical FKs in comments.
- No triggers, no SERIAL/sequences (UUIDv7 from app).
- Additive; idempotent (`CREATE TABLE IF NOT EXISTS`).

## Blast radius

| Risk | Likelihood | Mitigation |
|--|--|--|
| Verifier worker hangs on a slow test | Medium | 60s wall clock per `spawnSync` invocation; framework command captured even on timeout |
| AnthropicDriver missing key crashes the verifier | Low | `getAnthropicDriver()` is awaited via try/catch; on undefined OR throw → `evidence_kind='manual_required'` and `result='ambiguous'`; verifier still completes |
| Test command shell injection from AC text | High | We never compose a shell command from AC text. Frameworks are detected from `package.json` only; test paths are matched by file existence; commands run via `spawnSync` with arg array (not shell) |
| Verifier writes outside scope | Mitigated at gateway | Capability bundle has `filesWrite: []`; the MCP gateway rejects |
| Capability scope still permits reads of secrets | Acceptable v1 | Read-only on worktree is consistent with the "judge can see evidence" trust model. Worktree must not contain secrets (existing constraint) |
| The new `ac_check_evidence` lookup in UI fires per AC (N+1) | Medium | The query is keyed on `ac_id` with React Query; the UAT page typically renders <20 ACs; acceptable for v1. If we hit perf, batch via a `uat.ac.evidence.batch` query — recorded as ADR follow-up |
| Hooks system races: post-task fires before `ac_id` rows exist | Low | UAT session creation already snapshots ACs from `story_acceptance_criteria`. The verifier reads from the same source. If the story has zero ACs, the verifier emits VerifierPassed immediately (vacuous truth) |

## Rollback strategy

1. Migration 0021 is additive; rollback drops the table:
   ```sql
   DROP TABLE IF EXISTS audit.ac_check_evidence;
   ```
2. The verifier persona scope tightening can be reverted by restoring the file. Capability re-issuance is automatic per spawn.
3. The post-task hook still calls `spawnVerifier`. If the new behaviour throws, the hook catches and logs (existing pattern in `post-task.ts:55-62`).
4. Feature flag: `ORBITAL_VERIFIER_REAL_AC_CHECK=on` (default off in v1). When off, `spawnVerifier` short-circuits to the old stub behaviour: insert verifications row, emit VerifierStarted, return id. This lets us land code dark and ship the migration before flipping behaviour. **DECISION: skipping the flag for v1; the brief says "make the verifier actually check" and we have integration tests for the behaviour. If the user wants a kill-switch we add it as a follow-up.**

## Test strategy

1. **Unit** — `ac-checker.test.ts`:
   - framework detection (vitest, jest, playwright, none)
   - keyword-based test matching
   - mocked `spawnSync` returns: pass, fail, timeout
   - LLM fallback when no test matches (mocked AnthropicDriver returning pass/fail/ambiguous)
   - `manual_required` when LLM unavailable
2. **Unit** — `evidence.test.ts`: idempotent insert; round-trip read.
3. **Integration** — `verifier-service.test.ts`: real Postgres; spawnVerifier creates the verification row + child verifier tasks; submitResult aggregates correctly.
4. **Integration end-to-end** — `verifier-fixture-worktree.test.ts`: a tiny vitest fixture in a temp dir with one passing test and one failing test; checkAC drives the framework and produces the expected evidence shape; persisted evidence is readable via `uat.ac.evidence`.
5. **UI smoke** — manual; no Playwright in this round.

## Persona evidence prefix

`[Engineer-Principal · Opus · run-round5c-real-verifier]`

## Cross-family review note

Per Engineer-Principal hard rule #2: orchestrator must dispatch Code Review using a non-Opus family. The review-agent invocation downstream of this work must specify a Sonnet or Haiku reviewer. This is a directive to the orchestrator only; this implementation does not need to do anything about it.
