# Vision → LLM-driven decomposition (Engineer-Principal)

## Bounded contexts touched
- **vision** (orchestrator) — decomposer becomes LLM-backed
- **drivers/anthropic** — gains constructor-injected API key (no env coupling)
- **db/schema** — new `planning_runs` audit table (additive, tenant-scoped)
- **trpc/routers** — new `planning` router (history / regenerate / commit)
- **api-lambda** — `init.ts` reads new secret on cold start
- **infra (CDK)** — `api-lambda` Lambda role gets GetSecretValue on Anthropic secret ARN
- **ui** — `Vision.tsx` extended (Generate plan CTA + proposal editor)

## Aggregate boundaries
- `vision_documents` / `vision_versions` — read-only input
- `epics`, `stories`, `story_acceptance_criteria` — write target on commit (existing transactional path preserved)
- `planning_runs` — new aggregate, write-only audit, tenant-scoped, no FK

## Event flow
- `planning.regenerate` → calls VisionDecomposer (LLM mode) → returns proposal in-memory; writes `planning_runs` row with `committed_at = NULL`.
- `planning.commit` → re-validates proposal with Zod → existing decompose() transaction path with OCC retry → emits `EpicCreated` / `StoryCreated` / `BacklogAutoDecomposed` → updates the same `planning_runs` row with `committed_at`.
- `planning.history` → SELECT FROM planning_runs WHERE tenant_id = ? AND vision_id = ?.

## IAM diff
- api-lambda execution role: add `secretsmanager:GetSecretValue` on `arn:aws:secretsmanager:us-east-1:403001214246:secret:prometheus/mwitt/global/claude-api-key-KRa6jp`.
- No KMS change (secret is unencrypted JSON; same pattern as DB creds).

## DSQL schema diff
- New table `planning_runs` (uuid pk, tenant_id default sentinel, jsonb raw_response, no FK, no triggers).
- Composite index `(tenant_id, vision_id, started_at desc)` for history queries.

## Blast radius
- Backend: epic-suggester now calls Claude. Failure mode: ProviderError → router returns INTERNAL with reason "llm_unavailable", no DB rows written. Existing template path retained as fallback.
- UI: only adds a button under "Lock vision" — no existing flow changed.
- Lambda cold-start: +1 secret fetch. Cached via `getSecrets` (already fetches multiple secrets; adding one is sub-linear).

## Rollback strategy
- Migration 0040 is `CREATE TABLE IF NOT EXISTS` — purely additive.
- Code rollback: revert two commits (backend + UI) and redeploy previous Lambda version via `aws lambda update-alias --function-version <prev>`.
- No data migration to reverse.

## Cost guard
- Hard $5 cap per generation. We enforce by:
  1. Token-count the system + user prompt with `client.messages.countTokens` (~ free).
  2. Estimate cost: input_tokens × $15/1M + max_output_tokens × $75/1M for Opus.
  3. If estimated cost > $5, refuse before sending.
  4. After response: actual cost (input + output × prices) recorded in planning_runs.
  5. Threshold safety: `max_tokens` capped at 8000 to bound output cost.

## Confidence: 90
Rationale: backend pieces are well-understood drop-ins. UI piece + live-deploy verification with $5 spend is the unknown. Below 95 threshold for High risk; flagging deploy + live test as remaining work to be picked up in a focused follow-up session.
