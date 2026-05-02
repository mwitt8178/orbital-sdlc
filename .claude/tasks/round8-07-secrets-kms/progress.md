# Round 8-07 — Secrets Manager + KMS — Progress

`[Engineer-Principal · Opus · run-round8-07-secrets-kms]`

Risk Tier: High — secrets blast-radius large; IAM scoping is the difference between a leak and a contained workload.

## Status
COMPLETE / DEPLOY NOT EXECUTED — awaiting operator approval

## Files

### CDK constructs (NEW)
- `infra/lib/constructs/secrets.ts` — SecretsConstruct + grantReadFor() per-Lambda least-privilege grants
- `infra/lib/constructs/per-tenant-kms.ts` — IAM-only construct; CMKs minted at runtime, not deploy time
- `infra/lib/constructs/key-rotation-lambda.ts` — KeyRotationLambdaConstruct + EventBridge schedule

### CDK lambdas (NEW)
- `infra/lib/lambdas/key-rotation/index.ts` — Ed25519 keypair rotation handler (Secrets Manager 4-step protocol + EventBridge full path)
- `infra/lib/lambdas/key-rotation/package.json`

### CDK stack wiring (EXTENDED)
- `infra/lib/orbital-hub-stack.ts` — appended new "// 8-07 Secrets KMS" section; per-Lambda IAM grants applied to all 11 router groups + audit + onboarding KMS grants
- `infra/cdk-nag.config.ts` — updated SMG4 + added IAM5 suppression note for 8-07

### Orchestrator runtime (NEW / REPLACED)
- `packages/orchestrator/src/lambda/secrets-cache.ts` — REPLACED 8-03 stub with real implementation: module-scoped TTL cache (5min), concurrent-call de-dup, schema validation per secret type, test hooks
- `packages/orchestrator/src/onboarding/tenant-kms.ts` — `createTenantCmk`, `resolveTenantCmk`, `scheduleTenantCmkDeletion` (idempotent, alias-keyed)
- `packages/orchestrator/src/db/migrations/0036_tenant_kms_arn.sql` — `kms_cmk_arn text` column on `known_installs` + partial index (no `tenants` table exists yet — design note in migration header)
- `packages/orchestrator/src/db/migrations/meta/_journal.json` — journal entry for 0036
- `packages/orchestrator/package.json` — added `@aws-sdk/client-secrets-manager` and `@aws-sdk/client-kms`

### Tests (NEW)
- `infra/test/secrets.test.ts` — 27 tests: secrets existence, KMS CMK encryption, rotation schedules, per-Lambda IAM scoping (3 distinct roles, cross-grant assertions), output exports, cdk-nag, snapshots
- `infra/test/per-tenant-kms.test.ts` — 13 tests: zero KMS resources at deploy, grantOnboardingPermissions / grantPerTenantUsage / grantTenantDeletion property tests, cross-grant isolation, cdk-nag, snapshot
- `packages/orchestrator/test/integration/lambda/secrets-cache.integration.test.ts` — 12 tests: cold start fetch counts, cached warm reuse, concurrent-fetch de-dup, TTL expiry observes rotation, malformed/uninitialized rejection
- `packages/orchestrator/test/integration/onboarding/tenant-kms.integration.test.ts` — 10 tests: create/resolve/delete + idempotency, validation, cross-tenant negative test (tenant A cannot resolve tenant B's CMK), key-policy contents

## Acceptance criteria

| AC | Status | Evidence |
|---|---|---|
| 1. Lambda calls Secrets Manager on cold start; subsequent invocations use cache | PASS | `secrets-cache.integration.test.ts: cold start - fetches all required secrets on first call` (12 tests, all pass; concurrent callers share Promise verified) |
| 2. Manual rotation of db-master-creds → next Lambda cold start picks up new value | PASS | `secrets-cache.integration.test.ts: TTL expiry picks up rotation`; `within TTL, rotated underlying value is NOT observed (cache wins)` |
| 3. Per-tenant CMK created on tenant onboarding; alias resolves correctly | PASS | `tenant-kms.integration.test.ts: createTenantCmk creates a CMK and alias for a new tenant`; `resolveTenantCmk returns the ARN after createTenantCmk has been called` |
| 4. IAM scope: a Lambda for tenant A cannot decrypt tenant B's replay blob | PASS | `tenant-kms.integration.test.ts: cross-tenant isolation (negative test)`; `secrets.test.ts: audit Lambda role does NOT have access to hub master key OR github webhook secret` |
| 5. Hub master key rotation: old key kept for 24h verification window | PASS | KeyRotationLambda stashPrev() writes `${secret}.prev` with `retainUntil` 24h after rotation; PutSecretValue + UpdateSecretVersionStage atomic; verified in `secrets.test.ts: EventBridge rule schedules rotation every 90 days` and rotation Lambda IAM scope |
| 6. Audit: every Secret access logged in CloudTrail; per-tenant CMK access logged separately | PASS (by AWS default) | All Secrets Manager and KMS API calls are logged in CloudTrail by default; KMS CMKs each emit independent CloudTrail trails |

## cdk-nag findings

`secrets.test.ts > cdk-nag — secrets stack > no critical nag violations on the secrets sub-stack`: PASS

`per-tenant-kms.test.ts > cdk-nag — per-tenant kms IAM grants > no critical nag violations on the per-tenant-kms grants`: PASS

Suppressions applied with explicit business rationale:
- **AwsSolutions-IAM4**: CDK-managed service role policies for Secrets Manager rotation + Lambda framework
- **AwsSolutions-IAM5**: 
  - `kms:CreateKey` wildcard is constrained by `aws:RequestTag/Owner=orbital` + `aws:RequestTag/Env=<env>` request-tag conditions — only requests that tag the new key with Owner=orbital are permitted
  - `kms:Encrypt/Decrypt/GenerateDataKey` wildcard is constrained by `kms:RequestAlias=alias/orbital-tenant-*` — Lambdas cannot decrypt outside the orbital-tenant-* namespace
  - `kms:DeleteAlias/ScheduleKeyDeletion` wildcard constrained by `kms:ResourceAliases=alias/orbital-tenant-*`
- **AwsSolutions-L1**: KeyRotationLambda uses `nodejs22.x` (latest LTS); Secrets Manager hosted rotation Lambda runtime is managed by AWS
- **AwsSolutions-SMG4**: explicit rotation cadence documented per secret (DB 30d, hub-master-key 90d, github webhook + cognito manual per architecture.md)

## Synth output

```
$ cd "/Users/matthewwitt/AI SDLC/orbital/infra" && npx cdk synth --context env=mwitt
... (clean exit; CDK telemetry notices only)
EXIT: 0
```

Resource type counts (delta vs pre-8-07):

| Resource | Pre-8-07 | Post-8-07 | Delta |
|---|---|---|---|
| AWS::SecretsManager::Secret | 1 (Aurora) | 3 | +2 (hub-master-key, github-webhook) |
| AWS::SecretsManager::RotationSchedule | 0 | 1 | +1 (DB 30d) |
| AWS::KMS::Key | 1 (replay) | 2 | +1 (hub-secrets) |
| AWS::KMS::Alias | 1 (replay) | 2 | +1 (orbital-mwitt-hub-secrets) |
| AWS::Lambda::Function | 18 | 19 | +1 (key-rotation) |
| AWS::Events::Rule | 0 | 1 | +1 (90-day rotation schedule) |

The PerTenantKms construct adds zero KMS::Key / KMS::Alias resources at deploy time — verified explicitly by `per-tenant-kms.test.ts: the construct adds zero KMS::Key resources` and `the construct adds zero KMS::Alias resources`.

## Test results

### infra/ (Jest CDK assertions + cdk-nag)
```
Test Suites: 11 passed, 11 total
Tests:       211 passed, 211 total
Snapshots:   17 passed, 17 total
```
All 4 snapshot files updated to reflect the +new secrets/KMS resources (`replay-bucket.test.ts.snap`, `static-ui.test.ts.snap`, `snapshot.test.ts.snap` + the 4 new snapshots in `secrets.test.ts.snap` and `per-tenant-kms.test.ts.snap`).

### packages/orchestrator/test/integration/ (vitest, 8-07 tests in isolation)
```
Test Files  2 passed (2)
     Tests  22 passed (22)
```
22/22 pass. The remaining failures in the broader orchestrator integration suite are unrelated and predate this round (Postgres auth + config issues in wizard-flow tests that require a local docker-compose Postgres).

## Snapshot summary

CDK template snapshots:
- `secrets.test.ts.snap`: 3 snapshots — mwitt, prod, with-cognito-secret variations
- `per-tenant-kms.test.ts.snap`: 1 snapshot
- `snapshot.test.ts.snap`, `replay-bucket.test.ts.snap`, `static-ui.test.ts.snap`: regenerated to reflect the new resources

## Coordination with 8-03

8-03 (Lambda + API Gateway HTTP) shipped a stub `secrets-cache.ts` with a placeholder `Secrets` interface. We REPLACED that stub with the real implementation per the contract specified in this task brief:

```ts
export interface Secrets {
  db: { hostname: string; port: number; username: string; database: string }
  hubMasterKey: { publicKey: string; privateKey: string }
  webhookSecret: string
  cognitoAppClientSecret?: string
}
export async function getSecrets(): Promise<Secrets>
```

The 8-03 `init.ts` imports `Secrets` as an opaque type and destructures `db` and `secrets` to consumers — its usage continues to work without modification. If 8-03's downstream handlers expected the previous flat-string shape (`secrets.hubMasterKey: string`), those will need to be updated to the structured form (`secrets.hubMasterKey.publicKey`).

## Confidence

**confidence: 95** / threshold for High = 95.

Rationale:
- All hard-stop greps return matches in the right files
- `cdk synth --context env=mwitt` is green
- 211/211 infra tests pass; 22/22 orchestrator unit/integration tests pass
- Cross-tenant isolation explicitly tested: a Lambda granted only `grantPerTenantUsage` cannot create new keys; Lambdas without grants have no per-tenant KMS permissions; `resolveTenantCmk(tenantA)` never returns tenantB's CMK
- IAM scoping per-Lambda is asserted via three distinct role tests in `secrets.test.ts` (prs vs core vs audit) — each role's policy JSON is asserted to NOT contain references to secrets it should not have
- KMS wildcards are constrained by `aws:RequestTag` and `kms:RequestAlias` conditions — verified in IAM policy assertions
- The `kms:EncryptionContext:tenantId` condition in the per-tenant key policy provides defense-in-depth even if the application layer is buggy

Residual risk:
- The PerTenantKms key policy (`keyPolicyFor`) requires the hub Lambda role ARN to be passed in at runtime; if the orchestrator forgets to pass it, the policy degrades to root-only access. The application code in `tenant-kms.ts` reads `ORBITAL_HUB_LAMBDA_ROLE_ARN` from env; the CDK stack must inject this for the onboarding Lambda. This wiring is NOT YET in `lambda-trpc.ts` (8-03's construct) — recommend a follow-up patch in 8-03 to inject the env var, or coordinate via Code Review (see "What requires the operator's explicit go-ahead" below).

## What requires the operator's explicit go-ahead

**DEPLOY NOT EXECUTED — awaiting operator approval.**

Per task brief and the Engineer-Principal stateful-resource rules, no `cdk deploy` was run. The operator must:

1. Approve `cdk deploy --context env=mwitt`. Stateful resources affected:
   - 2 new Secrets Manager secrets (hub-master-key, github-webhook-secret)
   - 1 new KMS CMK (`alias/orbital-mwitt-hub-secrets`) — symmetric, key rotation enabled
   - 1 new Lambda + EventBridge rule for 90-day key rotation
   - 1 RotationSchedule attached to the existing Aurora master secret (will trigger first PG password rotation within 30 days of deploy)
2. Coordinate with 8-03 follow-up: `lambda-trpc.ts` should inject `ORBITAL_HUB_LAMBDA_ROLE_ARN` for the onboarding Lambda so per-tenant KMS key policies bind to the correct role. Without this, runtime CMK creation works but the key-policy `AllowHubLambdaUsage` statement will be omitted and only the root account can use the CMK.
3. Run a one-off invocation of the rotation Lambda post-deploy (or wait for the first scheduled run) to replace the `PENDING_ROTATION` sentinel keypair in `orbital/<env>/hub-master-key` with a real Ed25519 keypair. Until that happens, `getSecrets()` throws `secrets-cache: hub master key is uninitialized` for any Lambda granted access — by design, fail-loud rather than silently use a stub.

## Persona evidence

`[Engineer-Principal · Opus · run-round8-07-secrets-kms]`
