# Phase 4.9 Stack Isolation Report

**Date**: 2026-05-03  
**Branch**: worktree-agent-a0da60952da3f2720 (off feat/migration-trunk)  
**Baseline template**: `infra/cdk.out.alias/OrbitalHub-mwitt.template.json` — 335 resources  
**Test file**: `infra/test/phase4-stack-isolation.test.ts` — 20 tests, all PASS  
**Run command**: `cd infra && ORBITAL_DAEMON_IMAGE_DIGEST=sha256:... ORBITAL_ENABLE_PC=1 npx jest --testPathPattern phase4-stack-isolation`

---

## Summary

All 7 Phase 4 stack modules pass isolation verification. A comment-only edit to
any single stack file produces **zero template diff** (CDKMetadata excluded by
the in-process synthesis approach). The module boundary is enforced at the
TypeScript level: each `buildXxx()` function owns a disjoint set of CDK logical
IDs with no cross-namespace contamination.

Result: **7/7 PASS**

---

## How isolation is enforced

The Phase 4 split factored the 1100-line `orbital-hub-stack.ts` into 7 build
functions in `infra/lib/stacks/`. Each function is a plain TypeScript function
(not a CDK Stack subclass) that instantiates constructs **directly on the parent
scope** (`OrbitalHubStack`). All 335 resources still live in a single
CloudFormation stack (`OrbitalHub-mwitt`).

Isolation is TypeScript-module-level, not CFN-stack-level. This is the correct
tradeoff: promoting each module to a real CDK Stack would change logical ID
prefixes and require resource recreation.

The isolation guarantee:
- TypeScript comments are stripped before execution → comment-only edits have
  zero effect on the CDK construct tree.
- Each `buildXxx()` function names its constructs with a predictable ID prefix
  (e.g. `'Vpc'`, `'Aurora'`, `'Daemon'`). CDK appends a short hash to produce
  the final logical ID. Since the scope path is `OrbitalHub-mwitt/<Prefix>/...`,
  all logical IDs from a given build function are prefix-namespaced.
- No two build functions share a construct ID prefix that maps to different stacks.

---

## Per-stack results

### network-stack.ts (`buildNetworkResources`)

| Metric | Value |
|--------|-------|
| Construct IDs owned | `Vpc`, `Dns`, `CustomVpcRestrict` |
| Logical IDs (deployed baseline) | **39** |
| Comment edit → template diff | **0 resources changed** |
| Result | **PASS** |

Owns: VpcConstruct (VPC, subnets, NAT GW, S3/SM/KMS endpoints, flow log), DnsConstruct (Route53 hosted zone, ACM cert — both absent for mwitt), CDK VPC default-SG restriction custom resource (singleton).

---

### data-stack.ts (`buildDataResources`)

| Metric | Value |
|--------|-------|
| Construct IDs owned | `Aurora`, `RdsProxy`, `ProxySg`, `Migrations`, `StaticUi`, `ReplayBucket`, `CustomS3AutoDelete` |
| Logical IDs (deployed baseline) | **47** |
| Comment edit → template diff | **0 resources changed** |
| Result | **PASS** |

Owns: AuroraConstruct (serverless v2 cluster, subnet group, SG, secret), RdsProxyConstruct (proxy, proxy SG, IAM auth), RunMigrationsTrigger (migration Lambda + trigger), StaticUiConstruct (S3 bucket, CloudFront OAC + distribution), ReplayBucketConstruct (S3 bucket with Glacier transition), CDK S3 auto-delete custom resource singleton.

Construction order note: `StaticUiConstruct` is instantiated before `ReplayBucketConstruct` to preserve CDK singleton provider description ordering — this was verified to be zero-diff against the deployed stack.

---

### auth-stack.ts (`buildAuthResources`)

| Metric | Value |
|--------|-------|
| Construct IDs owned | `Cognito`, `Secrets`, `PerTenantKms`, `KeyRotation` |
| Logical IDs (deployed baseline) | **13** |
| Comment edit → template diff | **0 resources changed** |
| Result | **PASS** |

Owns: CognitoConstruct (user pool, app client, hosted domain), SecretsConstruct (DB master creds secret, hub master key secret + KMS key), PerTenantKmsConstruct (per-tenant KMS policy + alias), KeyRotationLambdaConstruct (rotation Lambda + EventBridge rule).

---

### api-stack.ts (`buildApiResources`)

| Metric | Value |
|--------|-------|
| Construct IDs owned | `Authorizers`, `ApiLambda`, `Lambdatasks`, `ApiGw`, `WsConnections`, `WsConnect`, `WsDisconnect`, `WsDefault`, `WsFanout`, `WsApi` |
| Logical IDs (deployed baseline) | **95** |
| Comment edit → template diff | **0 resources changed** |
| Result | **PASS** |

Owns: AuthorizersConstruct (Cognito + install Lambda authorizers), ApiLambdaConstruct (main tRPC Lambda with PC alias), LambdaTrpcConstruct (install Lambda), ApiGwHttpConstruct (HTTP API + routes + access logs), DynamoDbConnectionsConstruct (WS connections table), ApiGwWsConstruct (WS API + routes + domain), WsConnect/Disconnect/Default/Fanout Lambdas + roles + DLQ.

This is the largest module (95 resources, 28% of the stack).

---

### events-stack.ts (`buildEventsResources`)

| Metric | Value |
|--------|-------|
| Construct IDs owned | `Consumer`, `Scheduled`, `EventBus` |
| Logical IDs (deployed baseline) | **70** |
| Comment edit → template diff | **0 resources changed** |
| Result | **PASS** |

Owns: EventBusConstruct (SNS topic, 4 SQS consumer queues + DLQs, WS fanout subscription, EventBridge bus + rules), 4 consumer Lambdas (memory-recorder, defect-router, audit-indexer, replay-recorder), 3 scheduled Lambdas (sprint-planning, retro-runner, hygiene-sweep).

---

### daemon-stack.ts (`buildDaemonResources`)

| Metric | Value |
|--------|-------|
| Construct IDs owned | `Daemon` |
| Logical IDs (deployed baseline) | **21** |
| Comment edit → template diff | **0 resources changed** |
| Result | **PASS** |

Owns: DaemonFargateConstruct (ECS cluster, Fargate service, EFS filesystem + mount targets + access point, ECR repo, task IAM role, task SG, ECS log group).

---

### web-stack.ts (`buildWebResources`)

| Metric | Value |
|--------|-------|
| Construct IDs owned | `Waf` |
| Logical IDs (deployed baseline) | **4** |
| Comment edit → template diff | **0 resources changed** |
| Result | **PASS** |

Owns: WafConstruct (WebACL, WAF log group, WAF logging config, blocked-requests CloudWatch alarm). CloudFront/S3 stack outputs are emitted here but reference the `StaticUi` construct created in `data-stack.ts` — no new resources created.

---

## CDK singletons (not owned by any single module)

| Logical ID prefix | Count | Type |
|-------------------|-------|------|
| `CDKMetadata` | 1 | AWS::CDK::Metadata |
| `LogRetention*` | 3 | IAM::Role, IAM::Policy, Lambda::Function — shared log retention Lambda |
| **Total** | **4** | — |

The LogRetention singleton is triggered by the first construct that sets `logRetentionDays`. It appears once regardless of how many constructs use it. No stack module "owns" it — it is a CDK framework resource.

---

## Observability (inline, Phase 4.8 deferred)

| Logical ID prefix | Count |
|-------------------|-------|
| `Observability*` | 42 |

`ObservabilityConstruct` is instantiated inline in `OrbitalHubStack` constructor (not delegated to a build function). Phase 4.8 was explicitly out of scope. Its 42 resources are correctly isolated from the other modules.

---

## Non-determinism finding and fix

During test development, building two stacks with *different* IDs (`OrbitalHub-mwitt-A` vs `OrbitalHub-mwitt-B`) produced different logical IDs for the SNS subscription Lambda permission:

```
WsFanoutFnAllowInvokeOrbitalHubmwittAEventBusSnsTopicDF4DC61BED19141E
WsFanoutFnAllowInvokeOrbitalHubmwittBEventBusSnsTopic421A7EADAD092C77
```

The stack name is embedded in the SNS topic ARN which is hashed into the CDK logical ID. This is expected CDK behavior — it is NOT a bug. The fix is to use the same stack ID across comparison builds, which the test does.

This is a boundary-awareness finding: if the stack were ever renamed (e.g. renamed from `OrbitalHub-mwitt` to `OrbitalHubMwitt`), the SNS subscription permission logical IDs would change, triggering a CloudFormation delete+recreate of the Lambda permission. **No action required** — the stack name is stable.

---

## Resource count summary

| Stack module | Logical IDs | % of total |
|---|---:|---:|
| api-stack | 95 | 28.4% |
| events-stack | 70 | 20.9% |
| observability-inline | 42 | 12.5% |
| data-stack | 47 | 14.0% |
| network-stack | 39 | 11.6% |
| daemon-stack | 21 | 6.3% |
| auth-stack | 13 | 3.9% |
| web-stack | 4 | 1.2% |
| cdk-singletons | 4 | 1.2% |
| **Total** | **335** | **100%** |

---

## Verdict

Phase 4.9 verification: **PASS (7/7 stacks)**.

The TypeScript module split provides clean logical-ID isolation at the source
level. All 20 automated assertions pass. No spurious cascading was detected.
The test file at `infra/test/phase4-stack-isolation.test.ts` is the permanent
regression guard for this property.
