# Round 8-02 — Aurora Postgres + RDS Proxy + Migration Runner
## Progress

**Agent**: Engineer-Sr · Sonnet · run-round8-02-aurora  
**Status**: COMPLETE  
**Risk Tier**: Medium (no change from estimate)

---

## Files Created / Modified

### New Files

| File | Purpose |
|---|---|
| `infra/lib/constructs/aurora.ts` | Aurora Postgres Serverless v2 construct |
| `infra/lib/constructs/rds-proxy.ts` | RDS Proxy construct with Lambda placeholder SG |
| `infra/lib/lambdas/migration-runner/index.ts` | Lambda handler: applies Drizzle migrations via IAM auth |
| `infra/lib/lambdas/migration-runner/package.json` | Lambda deps: @aws-sdk/rds-signer, postgres |
| `infra/lib/triggers/run-migrations.ts` | CDK custom resource that invokes migration runner on every deploy |
| `infra/test/aurora.test.ts` | 20 property + snapshot tests for AuroraConstruct |
| `infra/test/rds-proxy.test.ts` | 17 property + snapshot tests for RdsProxyConstruct |
| `infra/test/migration-runner.test.ts` | 14 property + snapshot tests for RunMigrationsTrigger |
| `packages/orchestrator/test/unit/db/iam-auth.test.ts` | 7 unit tests for IAM auth path in db/client.ts |

### Modified Files

| File | Change |
|---|---|
| `infra/lib/orbital-hub-stack.ts` | Added `// Round 8-02 Aurora attach` section; wired AuroraConstruct + RdsProxyConstruct + RunMigrationsTrigger |
| `infra/cdk-nag.config.ts` | Added RDS6, RDS10, RDS11, RDS2, SMG4, L1 suppressions with justifications |
| `infra/test/snapshot.test.ts` | Updated nag suppressions list; regenerated snapshots with Aurora resources |
| `infra/tsconfig.json` | Added `lib/lambdas` to exclude (Lambda has own tsconfig) |
| `packages/orchestrator/src/config/env.ts` | Added RDS_PROXY_HOSTNAME, RDS_PROXY_PORT, AURORA_DB_NAME, AURORA_USERNAME env vars; coordinated with 8-06's ORBITAL_DEPLOY_TARGET field |
| `packages/orchestrator/src/db/client.ts` | Branched on ORBITAL_DEPLOY_TARGET=aws for IAM auth via RDS Proxy; added getDb() async accessor; maintained backwards compat |
| `packages/orchestrator/package.json` | Added @aws-sdk/rds-signer ^3.750.0 dependency |

---

## Acceptance Criteria

| # | Criterion | Status | Evidence |
|---|---|---|---|
| 1 | `cdk deploy --context env=mwitt` after 8-01 + 8-02 creates Aurora cluster + RDS Proxy | READY (not deployed) | `cdk synth --context env=mwitt` succeeds; template contains `AWS::RDS::DBCluster`, `AWS::RDS::DBProxy` |
| 2 | Migration runner Lambda invokes during deploy; CloudWatch shows migrations 0001–0035 applied | READY (not deployed) | Custom resource with `MigrationsHash` property triggers on every deploy; Lambda reads `migrations/` dir |
| 3 | `psql` from bastion connects to RDS Proxy and queries `events` table | DEPLOY REQUIRED | Proxy endpoint exported as `OrbitalHub-mwitt-RdsProxyEndpoint` |
| 4 | pgvector extension loaded | READY (not deployed) | Parameter group sets `pgvector.enabled=on`; `CREATE EXTENSION IF NOT EXISTS pgvector` in first migration via migration runner |
| 5 | Lambda IAM auth works | READY (not deployed) | `iamAuth: true` on DatabaseProxy; `grantConnect` on Lambda role; `@aws-sdk/rds-signer` in client.ts |
| 6 | Aurora Multi-AZ failover (prod) | READY (not deployed) | Prod config creates reader instance with `scaleWithWriter: true` |
| 7 | PITR test — list snapshots, restore-to-point | READY (not deployed) | Aurora automated backups always include PITR; 35-day retention for prod |

---

## TDD Cycle Log

**RED → GREEN → REFACTOR** per tdd-workflow skill.

### Cycle 1: AuroraConstruct
- RED: aurora.test.ts written with 20 assertions against non-existent construct
- GREEN: aurora.ts implemented — all 20 pass
- REFACTOR: Extracted parameter group, subnet group, master secret as named sub-constructs within the class

### Cycle 2: RdsProxyConstruct
- RED: rds-proxy.test.ts written with 17 assertions
- GREEN: rds-proxy.ts implemented — 17 pass
- REFACTOR: Added `existingProxySg` prop to break circular dependency with Aurora (proxy SG needed by Aurora before proxy cluster ref known)

### Cycle 3: RunMigrationsTrigger + migration-runner Lambda
- RED: migration-runner.test.ts written with 14 assertions
- GREEN: triggers/run-migrations.ts + lambdas/migration-runner/index.ts implemented — 14 pass
- REFACTOR: Moved crypto hash to standalone function; bundling strategy uses local bundler with Docker fallback

### Cycle 4: DB client IAM auth
- RED: iam-auth.test.ts written with 7 assertions
- GREEN: client.ts branching on `ORBITAL_DEPLOY_TARGET=aws` with `generateIamToken()` — 7 pass
- REFACTOR: Extracted `generateIamToken()` to a standalone async function; added `getDb()` async accessor

---

## Snapshot Test Summary

```
Test Suites: 6 passed, 6 total
Tests:       121 passed, 121 total
Snapshots:   10 passed, 10 total
```

Snapshot files written:
- `infra/test/__snapshots__/snapshot.test.ts.snap` — updated mwitt + prod stack snapshots (now include Aurora + RDS Proxy + Migration Runner resources)
- `infra/test/__snapshots__/aurora.test.ts.snap` — new: mwitt + prod Aurora stack snapshots
- `infra/test/__snapshots__/rds-proxy.test.ts.snap` — new: mwitt RDS Proxy stack snapshot
- `infra/test/__snapshots__/migration-runner.test.ts.snap` — new: mwitt migration runner stack snapshot

---

## CDK Synth Output (mwitt)

```
Resources synthesized: 93 AWS resources
  AWS::RDS::DBCluster        1  (Aurora Serverless v2, orbital-mwitt)
  AWS::RDS::DBInstance       1  (Serverless v2 writer, non-prod single-AZ)
  AWS::RDS::DBProxy          1  (orbital-mwitt-proxy)
  AWS::RDS::DBProxyTargetGroup  1
  AWS::RDS::DBClusterParameterGroup  1  (pgvector, pgaudit, pg_stat_statements)
  AWS::RDS::DBSubnetGroup    1  (isolated subnets)
  AWS::Lambda::Function      5  (migration-runner + custom resource provider framework)
  AWS::SecretsManager::Secret  1  (master credentials)
  AWS::IAM::Role / Policy    multiple (CDK-generated least-privilege)
```

---

## cdk-nag Findings

All suppressions are documented with business justifications in `infra/cdk-nag.config.ts`.

| Rule | Status | Justification |
|---|---|---|
| AwsSolutions-RDS6 | Suppressed | IAM DB auth IS enabled; cdk-nag false positive on Aurora Serverless v2 |
| AwsSolutions-RDS10 | Suppressed (non-prod) | DESTROY policy by design; prod uses RETAIN |
| AwsSolutions-RDS11 | Suppressed | Port 5432 is the correct Postgres standard port |
| AwsSolutions-RDS2 | Suppressed | StorageEncrypted explicitly true; Aurora always encrypts |
| AwsSolutions-SMG4 | Suppressed | Secret rotation Lambda planned for 8-07 |
| AwsSolutions-L1 | Suppressed | CDK custom resource provider uses own managed runtime; migration runner uses nodejs22.x |

cdk-nag test result: **no ERROR-level violations** (in mwitt or prod stacks).

---

## Self-Check Results

### DSQL/multi-tenant/security/observability

Not applicable — this round does not touch DSQL (Aurora Postgres is used, not DSQL). 

Multi-tenant: Aurora cluster is per-env (mwitt/rreed/prod are isolated stacks). Tenant-level encryption (per-tenant CMKs) is deferred to 8-07.

Security self-check:
- [x] IAM auth on RDS Proxy (no stored passwords for Lambda connections)
- [x] SG ingress: Aurora accepts only from Proxy SG; Proxy accepts only from Lambda SG
- [x] Storage encrypted at rest (AWS-managed KMS; per-tenant CMK in 8-07)
- [x] Isolated subnets for Aurora (no internet access)
- [x] Private-with-egress subnets for RDS Proxy and Lambda
- [x] No hardcoded credentials — all via Secrets Manager + IAM tokens

Observability self-check:
- [x] CloudWatch log group per Lambda with explicit retention
- [x] X-Ray tracing enabled on migration runner Lambda
- [x] Performance Insights enabled on Aurora instances
- [x] CloudWatch log exports for Aurora: `['postgresql']`

### Deferred

- Per-tenant KMS CMKs for Aurora encryption → 8-07
- Secret rotation Lambda for master credentials → 8-07
- Lambda authorizer integration → 8-03
- Full CloudWatch dashboard and alarms → 8-08

---

## DEPLOY NOT EXECUTED — awaiting operator approval

`cdk deploy --context env=mwitt` will provision billable AWS resources (~$50-80/month for Aurora Serverless v2 at idle). The synth and diff have been run and produce a valid CloudFormation template. Deploy requires explicit operator go-ahead per the architecture spec.

---

## Confidence

**confidence: 91**

Rationale:
- All 121 CDK tests pass green including snapshot tests and cdk-nag
- TypeScript compiles cleanly with zero errors
- CDK synth produces correct Aurora + RDS Proxy + Lambda resources (93 resources total)
- IAM auth path in client.ts has 7 unit tests covering token generation, SSL, error cases
- Main uncertainty (9 points): circular dependency between Aurora SG and RDS Proxy is resolved with a forward-reference SG pattern; this works at synth time but the CloudFormation deployment ordering needs to be verified at deploy time. If CFN creates the Aurora cluster before the proxy SG ingress rule is applied, a window exists. The `dependsOn` ordering should handle this but cannot be verified without an actual deploy.
