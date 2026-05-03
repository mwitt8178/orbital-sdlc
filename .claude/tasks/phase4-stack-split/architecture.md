# Phase 4 Stack Split — Architecture

[Engineer-Principal · Opus · run-phase4-stack-split]

## Bounded Contexts Touched

- `infra/lib/orbital-hub-stack.ts` — refactored to composition root; delegates to 7 sub-constructs
- `infra/lib/stacks/` — new directory containing 7 Construct subclass files
- `infra/bin/orbital.ts` — unchanged (still instantiates single OrbitalHubStack)

## Why Construct Classes, NOT Stack Classes

All resources currently live in `OrbitalHub-<env>`. Moving to 7 real CDK `Stack` instances would change every resource's logical ID prefix (e.g. `OrbitalHub-mwittVpc...` → `NetworkStack-mwittVpc...`). CloudFormation treats this as destroy-old + create-new, which would tear down the live `mwitt` VPC, Aurora cluster, Cognito pool, etc. This is unacceptable.

The safe model: each "stack file" at `infra/lib/stacks/*-stack.ts` exports a `Construct` subclass. `OrbitalHubStack` instantiates them as nested constructs using the **same logical ID prefix** as before. All CFN logical IDs remain identical. `cdk diff` shows 0 changes/additions/removals.

## Aggregate Boundaries

| File | Class | CDK Construct ID | Resources |
|---|---|---|---|
| `network-stack.ts` | `NetworkConstruct` | `Vpc`, `Dns` | VPC, subnets, VPC endpoints, DNS/ACM |
| `data-stack.ts` | `DataConstruct` | `Aurora`, `RdsProxy`, `Migrations`, `ReplayBucket` | Aurora cluster, RDS Proxy, migration trigger, S3 replay |
| `auth-stack.ts` | `AuthConstruct` | `Cognito`, `Secrets`, `PerTenantKms`, `KeyRotation` | Cognito, Secrets Manager, KMS |
| `api-stack.ts` | `ApiConstruct` | `Authorizers`, `ApiLambda`, `Lambda-tasks`, `ApiGw`, `WsConnections`, `WsApi`, WS Lambdas | API GW HTTP/WS, api-lambda, install-lambda, ws-* lambdas |
| `daemon-stack.ts` | `DaemonConstruct` | `Daemon` | ECS cluster, Fargate service, EFS, ECR |
| `events-stack.ts` | `EventsConstruct` | `EventBus` + consumer/scheduled Lambda IAM wiring | SNS topic, SQS queues, EventBridge, event-worker Lambdas |
| `web-stack.ts` | `WebConstruct` | `StaticUi`, `Waf` | CloudFront, S3 UI bucket, WAF |

Observability (`Observability`) stays in `OrbitalHubStack` directly per scope exclusion.

## Cross-Construct References

Constructs pass references as constructor props (TypeScript object references, not CFN Fn::ImportValue). Because all constructs live in the same CFN stack, CDK resolves these as direct attribute references (no cross-stack CFN exports needed). Dependency order:

```
NetworkConstruct
  → DataConstruct (needs vpc)
  → AuthConstruct (needs aurora.masterSecret)
  → ApiConstruct (needs vpc, rdsProxy, cognito, secrets, wsConnections)
  → DaemonConstruct (needs vpc, rdsProxy, eventBus.snsTopic, secrets)
  → EventsConstruct (needs wsFanoutFn, consumer/scheduled fns, apiLambda, daemonTaskRole)
  → WebConstruct (needs dns.certificate, dns.hostedZone, staticUi.bucket)
```

## IAM Diff

No IAM changes. All roles, policies, and grants are preserved bit-for-bit. The refactor moves code between files, not between logical construct paths.

## DSQL Schema Diff

No schema changes. This is infra-only.

## Blast Radius

- **Zero** on `mwitt` if cdk diff confirms 0 changes. The refactor is purely structural — TypeScript class boundaries, no CFN resource changes.
- Risk surface: if any construct ID is accidentally changed during the move, CFN sees a replacement. The validation gate (`cdk diff` showing 0 changes) is mandatory before any deploy.

## Rollback Strategy

The existing `orbital-hub-stack.ts` is kept intact. If the split causes any issue, revert by removing the `stacks/` directory and the delegation calls in `OrbitalHubStack` — the original constructor body can be restored. No AWS resources are touched until `cdk deploy` is run (and the task spec forbids running `cdk deploy`).

## Per-Stack Deploy Independence (Post-Split Goal)

Once the team is comfortable and wants true stack isolation in a future phase, the Construct classes can be promoted to Stack classes with explicit `CfnOutput` + `Fn.importValue` cross-stack references. That promotion is a separate migration with its own blast-radius analysis because it WILL require resource recreation per stack boundary crossing.

## Confidence

confidence: 97 — The composition root pattern is the standard CDK technique for logical grouping without logical ID disruption. The only residual risk is a typo in a construct ID during the move, caught by the mandatory `cdk diff` gate.
