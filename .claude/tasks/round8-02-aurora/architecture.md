# Round 8-02 — Aurora Postgres + RDS Proxy + Migration Runner

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: L

## Depends on
8-01 (CDK skeleton + VPC)

## Why
The hub's data store. Single Aurora cluster per env, fronted by RDS Proxy (mandatory for Lambda). Migrations from local Postgres applied automatically on deploy.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `infra/lib/constructs/aurora.ts` | NEW | Aurora Postgres Serverless v2 construct |
| `infra/lib/constructs/rds-proxy.ts` | NEW | Proxy in front of Aurora |
| `infra/lib/orbital-hub-stack.ts` | extend | Wire Aurora + Proxy |
| `infra/lib/lambdas/migration-runner.ts` | NEW | Lambda that runs Drizzle migrations on deploy |
| `infra/lib/triggers/run-migrations.ts` | NEW | CDK custom resource that invokes the migration runner during stack deploy |
| `packages/orchestrator/src/db/client.ts` | extend | When `ORBITAL_DEPLOY_TARGET=aws`, use IAM auth via RDS Proxy |
| `docs/aws-deployment.md` | extend | DB section: backups, recovery, scaling |

## Aurora construct
- Aurora Postgres 16 Serverless v2
- ACU range from env context (e.g., `mwitt`: 0.5–4 ACU; `prod`: 1–16 ACU)
- Multi-AZ: yes for prod, no for non-prod (cost saving)
- Encryption at rest: AWS-managed key (KMS CMK in 8-07 for tenant-specific encryption layer)
- Automated backups: 7 days for non-prod, 35 days for prod
- Point-in-time recovery enabled
- DB name: `orbital_hub`
- Master username: `orbital_admin` (creds in Secrets Manager — wired in 8-07)
- Storage: Aurora Serverless v2 manages this automatically
- Performance Insights: enabled
- Postgres parameters:
  - `pgvector.enabled = on` (Aurora Postgres supports pgvector via extension)
  - `shared_preload_libraries = 'pg_stat_statements, pgaudit'`
  - `log_min_duration_statement = 500ms`
  - `log_connections = on`, `log_disconnections = on`
- Security group: ingress only from RDS Proxy SG

Initial DB setup (one-time, post-create):
```sql
CREATE EXTENSION IF NOT EXISTS pg_stat_statements;
CREATE EXTENSION IF NOT EXISTS pgvector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
```
Done by the migration runner Lambda on first invoke.

## RDS Proxy construct
- Name: `orbital-${env}-proxy`
- Engine: postgres
- Auth: IAM (Lambda gets short-lived creds via signed token)
- Idle client timeout: 30 min
- Max connections: 95% of Aurora's max
- Security group: ingress from Lambda SG only
- Endpoints: read/write endpoint exposed; Lambda configured to use it

## Migration runner Lambda
A separate Lambda function that:
1. Reads `packages/orchestrator/src/db/migrations/*.sql` in order
2. Applies each via Drizzle's migration runner against the Aurora cluster
3. Uses RDS Proxy with IAM auth
4. Logs to CloudWatch
5. Idempotent — runs every deploy, skips already-applied migrations

Triggered by a CDK Custom Resource on every `cdk deploy`. The custom resource invokes the Lambda; Lambda exits 0 on success, fails the deploy on error.

Migration files copied into the Lambda's deploy artifact at synth time.

## Drizzle config for AWS
The orchestrator's existing Drizzle config (`packages/orchestrator/src/db/client.ts`) needs a branch:
```ts
if (env.ORBITAL_DEPLOY_TARGET === 'aws') {
  // Use IAM auth via RDS Proxy
  const signer = new Signer({ region, hostname, port, username })
  const token = await signer.getAuthToken()
  return drizzle(postgres({ host, port, user, password: token, database, ssl: 'require' }))
}
```

The hub-mode boot reads `ORBITAL_DEPLOY_TARGET` env (set by Lambda config in 8-03).

## Acceptance criteria
1. `cdk deploy --context env=mwitt` after 8-01 + 8-02 creates an Aurora cluster + RDS Proxy.
2. Migration runner Lambda invokes during deploy; CloudWatch shows migrations 0001–<latest> applied.
3. `psql` from a bastion in the VPC connects to RDS Proxy and queries the `events` table successfully.
4. pgvector extension is loaded (`SELECT * FROM pg_extension WHERE extname='vector'` returns row).
5. Lambda IAM auth works (test Lambda from 8-03 connects without password).
6. Aurora Multi-AZ failover (prod): kill primary, replica promotes within 30s.
7. PITR test (non-destructive): can list snapshots; can restore-to-point-in-time as a separate cluster.

## Hard-stop checks
```
grep -E "AuroraConstruct|aurora" infra/lib/constructs/aurora.ts
grep -E "RdsProxyConstruct|rds-proxy" infra/lib/constructs/rds-proxy.ts
grep -E "ORBITAL_DEPLOY_TARGET.*aws" packages/orchestrator/src/db/client.ts
ls infra/lib/lambdas/migration-runner.ts
```

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round8-02-aurora]`
