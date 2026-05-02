# Round 8 — AWS Migration (single-stack, multi-env, Cognito)

**Goal:** Take the Round 7 hub and run it on AWS. Single CDK stack contains everything (API Gateway, Aurora, Lambda, SNS/SQS, S3/CloudFront, Cognito). Deployable to any env (mwitt, rreed, prod) via `cdk deploy --context env=<name>`. End-to-end smoke tested post-deploy.

## Architectural mapping

| Round 7 self-host | Round 8 AWS |
|---|---|
| Postgres in Docker | **Aurora Postgres Serverless v2** + RDS Proxy |
| Fastify + tRPC | **Lambda + API Gateway HTTP** (one Lambda per tRPC router group) |
| In-process WS hub | **API Gateway WebSocket** + Lambda + DynamoDB connections |
| Postgres LISTEN/NOTIFY for fanout | **SNS + SQS + EventBridge** |
| Local fs replay blobs | **S3 with SSE-KMS** (per-tenant CMK) |
| Static UI | **S3 + CloudFront** (custom domain) |
| Hub master key on disk | **Secrets Manager + KMS** |
| `pino` to stdout | **CloudWatch Logs** (structured JSON) |
| Round 7 PKI signed envelopes (install→hub) | **Cognito user pool** for human auth + PKI envelopes for install→hub (coexist) |
| `docker-compose.hub.yml` | **CDK single stack per env** |

## Single stack design

ONE stack: `OrbitalHubStack`. Contains:
- VPC + subnets (public for ALB/CloudFront origin, private for Lambda+Aurora)
- Aurora Postgres Serverless v2 cluster
- RDS Proxy (mandatory for Lambda → Aurora)
- DynamoDB table for WS connections
- S3 bucket for replay blobs (with KMS) + S3 bucket for UI assets
- CloudFront distribution (UI bucket origin)
- API Gateway HTTP API + WebSocket API
- Lambda functions (one per logical handler group)
- SNS topic for event fanout + SQS queues for consumers
- EventBridge bus + scheduler rules for cron jobs
- Cognito user pool + identity pool + app client
- Secrets Manager: hub master key, DB creds, GitHub webhook secret, per-tenant CMKs
- WAF in front of API Gateway
- CloudWatch alarms wired to SNS topic for alerts
- Route 53 hosted zone (or CNAME records to existing zone)
- ACM cert for `<env>.orbital.team.dev`

## Multi-env design

`cdk.json` has context for each env:
```json
{
  "context": {
    "envs": {
      "mwitt": {
        "account": "111111111111",
        "region": "us-east-1",
        "domain": "mwitt.orbital.team.dev",
        "auroraMinAcu": 0.5,
        "auroraMaxAcu": 4
      },
      "rreed": {
        "account": "222222222222",
        "region": "us-west-2",
        "domain": "rreed.orbital.team.dev",
        "auroraMinAcu": 0.5,
        "auroraMaxAcu": 4
      },
      "prod": {
        "account": "333333333333",
        "region": "us-east-1",
        "domain": "orbital.team.dev",
        "auroraMinAcu": 1,
        "auroraMaxAcu": 16
      }
    }
  }
}
```

Deploy: `cdk deploy --context env=mwitt`. Each env gets its own fully isolated stack with its own database, its own Cognito pool, its own DNS subdomain.

Stack name pattern: `OrbitalHub-${env}`. CDK bootstrap per account/region required.

## Auth: Cognito + PKI coexist

Cognito and Round 7's PKI serve different jobs:

| | Cognito | PKI (Round 7-03) |
|---|---|---|
| Authenticates | Human browser sessions | Install → hub machine traffic |
| Mechanism | Email/password, Google SSO, MFA | Ed25519 signed envelopes |
| Token form | JWT (id_token, access_token) | Per-request signature |
| Where used | Browser UI → API Gateway | Local Orbital `hub-client` → Hub |

Cognito User Pool config:
- Email/password + Google OAuth + Microsoft OAuth (configurable per env)
- MFA optional for member, required for owner
- Password policy: 12+ chars, mixed case, number, symbol
- Account recovery: email-only (avoid SMS — too prone to social engineering)
- App client: SPA-friendly, OAuth code flow with PKCE

When a user logs into the browser UI:
1. Cognito hosted UI or custom-built form using Amplify Auth
2. Returns id_token/access_token
3. UI sends `Authorization: Bearer <token>` on every API request
4. Lambda authorizer verifies via Cognito public keys; injects `ctx.userId`, `ctx.email` into the request

When a local Orbital install talks to the hub:
- Round 7-03's signed envelopes (no Cognito involvement)

These NEVER cross. Browser UI always authed via Cognito; local install always authed via PKI.

## Sub-task breakdown (8 sub-tasks)

### 8-01: CDK skeleton + VPC + Cognito + DNS
**Engineer-Sr · L · Risk: Medium**
- CDK app structure (TypeScript)
- Single `OrbitalHubStack` class
- Per-env context loader (`mwitt`, `rreed`, `prod`)
- VPC with public/private subnets, NAT gateway
- Route 53 zone + ACM cert for `<env>.orbital.team.dev`
- Cognito user pool + app client + identity pool
- Empty stack deploys cleanly to all envs
- IaC test: snapshot test of synthesized template

### 8-02: Aurora Postgres + RDS Proxy + migration runner
**Engineer-Sr · L · Risk: Medium**
- Aurora Postgres Serverless v2 (min/max ACU per env context)
- RDS Proxy
- Security groups (Lambda SG only)
- Encryption at rest, automated backups, point-in-time recovery
- Migration runner: a Lambda that runs Drizzle migrations on deploy (or post-deploy hook)
- Connection pooler config

### 8-03: Lambda + API Gateway HTTP for tRPC
**Engineer-Sr · L · Risk: Medium**
- Refactor Fastify entrypoint into Lambda handler (`@trpc/server/adapters/aws-lambda`)
- One Lambda per logical router group (auth, tasks, memory, channels, etc.) for cold-start isolation
- Cognito JWT authorizer + PKI envelope authorizer (two authorizers; routes pick one)
- Lambda → RDS Proxy → Aurora connection
- Provisioned Concurrency on hot paths (auth, tasks.list)
- API Gateway custom domain mapping
- Response caching where appropriate (e.g., team.members)

### 8-04: WebSocket API
**Engineer-Sr · M · Risk: Medium**
- API Gateway WebSocket API
- $connect Lambda: validate auth (Cognito for browser, PKI for install), write connection to DynamoDB with TTL
- $disconnect Lambda: cleanup
- $default Lambda: handle subscribe/unsubscribe messages
- Fanout Lambda: triggered by SNS event → look up DynamoDB connections → push via API GW Mgmt API
- DynamoDB connections table (PK: connection_id, GSI: install_id, GSI: tenant_id)

### 8-05: Event bus (SNS + SQS + EventBridge)
**Engineer-Sr · M · Risk: Medium**
- SNS topic `orbital-events-${env}`
- SQS queues per consumer: `memory-recorder`, `defect-router`, `audit-indexer`, `replay-recorder`
- All queues with DLQs
- EventBridge bus for scheduled jobs
- EventBridge Scheduler rules: ceremony cron (sprint planning at 9am, retro at 5pm, etc. — user-tz aware)
- SNS → SQS message attributes carry tenant_id for fanout filtering

### 8-06: S3 + CloudFront + Replay storage
**Engineer-Sr · M · Risk: Low**
- UI bucket: private, fronted by CloudFront with OAC
- CloudFront: custom domain, TLS, cache behavior tuned (long cache for hashed assets, no cache for index.html)
- Replay bucket: private, SSE-KMS with per-tenant CMK
- `replay/store.ts` (Round 6 #7) gets new `S3Store` driver
- Lifecycle: replay blobs hot 30d → IA → Glacier 90d
- GitHub Actions on `main`: build UI → upload to S3 → invalidate CloudFront

### 8-07: Secrets Manager + KMS
**Engineer-Sr · M · Risk: High**
- Secrets Manager: hub master key, DB master creds, GitHub webhook secret
- IAM roles for each Lambda granting only the secrets it needs
- Per-tenant CMKs in KMS for replay blob encryption
- Secret rotation Lambda for hub master key (90-day rotation)
- Boot code in hub Lambda reads from Secrets Manager via SDK on cold start; cached in module scope (with TTL refresh)

### 8-08: Observability + WAF + Alarms
**Engineer-Sr · M · Risk: Low**
- CloudWatch Logs: one log group per Lambda; structured JSON; 30-day retention (configurable per env)
- X-Ray tracing: enabled on every Lambda
- CloudWatch Dashboard: API latency p50/p99, Lambda error rate, WS connection count, SQS depth, Aurora CPU/connections, RDS Proxy connection borrows, Cognito sign-in rate
- Alarms (rate-based) for: 5xx > 1%/min, Lambda error rate > 5%/min, SQS DLQ depth > 0, Aurora CPU > 80% sustained, RDS Proxy connection-pool exhaustion
- Alarms → SNS topic → email + (optional) Slack via lambda
- WAF: rate limit 1000 req/min per IP, AWS-managed common rule set, AWS-managed bad-input set
- WAF in front of HTTP API + WS API

### 8-09: Cutover + multi-env smoke + deploy scripts
**Engineer-Principal · L · Risk: High**
- Self-host hub data export script (pg_dump)
- Aurora restore script
- DNS cutover playbook (low TTL pre-cutover, switch, watch)
- Multi-env smoke test suite: deploy to mwitt env → run smoke tests → tear down → repeat for rreed
- Smoke tests cover: Cognito sign-in, tRPC tasks.list, WS subscribe + receive, replay capture + playback, event fanout to SQS, SNS → fanout Lambda, Lambda → Aurora roundtrip
- `scripts/deploy-env.sh <env>` — one-command deploy
- `scripts/teardown-env.sh <env>` — one-command teardown for non-prod envs
- Rollback procedure documented + scripted

## Cost shape per env

For one operator's hub at moderate use (5 active workers, 8h/day):

| | Idle | Active (8h/day) | Per month |
|---|---|---|---|
| Aurora Serverless v2 (0.5–4 ACU) | $40 | $80 | $50–80 |
| Lambda + API GW HTTP | $0 | $5 | $5 |
| WS API + DynamoDB | $0 | $3 | $3 |
| S3 + CloudFront | $1 | $2 | $2 |
| SNS + SQS + EventBridge | $1 | $2 | $2 |
| Secrets Manager (5 secrets) | $5 | $5 | $5 |
| CloudWatch + X-Ray | $5 | $15 | $15 |
| WAF | $10 | $10 | $10 |
| Cognito (50 MAU) | free | free | $0 |
| **Total per env** | **~$60** | **~$125** | **~$90/mo** |

3 envs (mwitt + rreed + prod) ≈ $270/mo at active baseline.

## Acceptance criteria (round-level — sub-tasks have own)
1. `cdk deploy --context env=mwitt` produces a fully-functional hub at `mwitt.orbital.team.dev`.
2. `cdk deploy --context env=rreed` produces a fully-functional hub at `rreed.orbital.team.dev` with NO data crossover.
3. Cognito sign-in flow works in browser; user lands on Dashboard authenticated.
4. Local Orbital install with Round 7 PKI authenticates to hub; tRPC requests round-trip.
5. WS subscribe → publish event → receive within 500ms.
6. Replay blob written → readable from S3 with KMS decrypt.
7. Smoke test suite (8-09) all green on mwitt env.
8. `cdk teardown --context env=mwitt` removes everything cleanly (no leftover billable resources).
9. Pre-existing self-host hub continues to work in parallel; cutover is a DNS change.
10. Deploy + smoke + teardown documented in `docs/aws-deployment.md`.

## What requires the operator's explicit go-ahead

CDK code: agent-writable. `cdk deploy` against your AWS account: needs your explicit thumbs-up because it provisions billable resources. The deploy script will print:
- Estimated monthly cost
- List of resources being created
- Confirmation prompt

Set `ORBITAL_AUTO_APPROVE_DEPLOY=1` to skip confirmation if you want fully autonomous deploys.

## Persona evidence prefix
Each sub-task: `[Engineer-{tier} · {model} · run-round8-NN-{name}]`
