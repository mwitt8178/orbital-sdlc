# Round 7-01 — Extract Orchestrator Core Into Hub Service
# progress.md
# [Engineer-Sr · Sonnet · run-round7-01-extract-hub]

## Skill Self-Checks

### DSQL / aws-dsql-constraints
- No FKs added: confirmed (logical FKs only in test inserts, mirroring existing schema pattern)
- No sequences/SERIAL: confirmed, all PKs are UUIDv7
- OCC retry: ProposalService transactions use existing OCC pattern (no new raw transactions added)
- Separate DDL from DML: no migrations in this run
- ID generation: uuidv7() throughout

### multi-tenant-isolation
- tenant_id in schema: all tables touched have tenantId column (or documented exception)
- tenant_id in query: EVERY SELECT adds eq(table.tenantId, tenantId) condition
- tenant_id in INSERT: all INSERT paths pass tenantId from ctx or SENTINEL default
- tenant_id in UPDATE/DELETE: WHERE clauses include tenantId
- Bleed tests: 25 integration tests (I1-I16), all green

### security-serverless
- No new IAM changes in this run
- Least-privilege: tenantId scoping reduces data surface per request

### observability
- Existing logger.info/warn calls preserved; no new observability gaps introduced

---

## Scope Summary (this run — "Deferreds resolved" followup)

### Work completed

**Service layer tenantId threading:**
- `projects/service.ts` — tenantId on all CRUD (prior run)
- `backlog/service.ts` — tenantId on epics/stories/groom (prior run)
- `backlog/sprint-service.ts` — tenantId on sprints (prior run)
- `memory/service.ts` — tenantId on all memory operations (prior run)
- `uat/service.ts` — tenantId on sessions (prior run)
- `retros/proposals.ts` — tenantId added to ProposalService interface (approve/reject/defer/rollback), SENTINEL_TENANT default, `getProposalOrThrow` scoped with AND eq(tenantId)

**Router void replacements (this run):**
- `retros.ts` — ALL 8 procedures now properly scoped:
  - `report.get`: and(reportId, tenantId) (prior run)
  - `proposal.list`: conditions start with tenantId (prior run)
  - `proposal.approve`: passes ctx.tenantId to service as 5th arg
  - `proposal.reject`: passes ctx.tenantId to service as 5th arg
  - `proposal.defer`: passes ctx.tenantId to service as 5th arg
  - `rollback`: passes ctx.tenantId to service as 5th arg
  - `outcomes.list`: scoped via retroProposals tenant subquery (retroOutcomes has no tenantId)
  - `versions.list`: scoped via retroReports tenant subquery (systemVersions has no tenantId)
- `code-reviews.ts` — 2 void sites fixed:
  - `byPR`: and(prNumber, tenantId)
  - `requestRework`: review lookup scoped, task lookup scoped, UPDATE scoped
- `channels.ts` — 2 void sites fixed:
  - `post.create`: tenantId forwarded through CreatePostParams to INSERT
  - `subscribe`: tenantId forwarded through options to channelSubscriptions INSERT
- `orchestration.ts` — 3 sites addressed:
  - `tasks.prStatus`: and(taskId, tenantId)
  - `escalations.list`: innerJoin(tasks) + eq(tasks.tenantId, ctx.tenantId)
  - `workers.list`: DOCUMENTED as intentional — agentWorkers has no tenantId column (process-scoped infra)

**Service changes to support router tenantId passing:**
- `comms/types.ts`: tenantId? added to CreatePostParams
- `comms/channels.ts`: subscribe() options.tenantId threaded to INSERT; post() INSERT uses params.tenantId

### Remaining intentional void ctx.tenantId (documented)

1. `memory.ts:113` (search): retrieveTopN has no tenantId param; projectId is tenant-scoped
2. `uat.ts:242` (ac.evidence): acCheckEvidence table has no tenantId column
3. `orchestration.ts:195` (workers.list): agentWorkers table has no tenantId column

### Integration tests
- `test/integration/hub/tenant-isolation.integration.test.ts`
- 9 pre-existing tests (I1-I5) + 16 new tests (I6-I16) = 25 total, all green
- NEW test coverage: epics, stories, sprints, memory entries, retro reports/proposals, code reviews, channel posts, channel subscriptions, UAT sessions, cross-tenant UPDATE no-op

### TypeScript
- `npx tsc --noEmit` — zero errors

---

## Deferred

- `agentWorkers` tenantId column: requires schema migration (DDL) — out of round-7-01 scope
- `acCheckEvidence` tenantId: same
- `escalations` tenantId column: currently scoped via JOIN to tasks — functionally correct but a direct column would be more efficient; deferred to schema migration round

---

## Risk Assessment

Risk Tier: Medium (unchanged from initial assessment)
- Multi-tenant write paths scoped at service layer with tenantId required
- Backward compat preserved via SENTINEL_TENANT defaults
- No new AWS/IAM/CDK changes
- Integration tests confirm cross-tenant bleed is blocked
