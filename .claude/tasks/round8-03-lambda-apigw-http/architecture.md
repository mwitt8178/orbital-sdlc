# Round 8-03 — Lambda + API Gateway HTTP for tRPC

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: L

## Depends on
8-01 (CDK + Cognito), 8-02 (Aurora + RDS Proxy)

## Why
Replace Fastify with Lambdas behind API Gateway HTTP API. Cognito JWT authorizer for browser traffic; PKI-envelope authorizer (Round 7-03) for install-to-hub traffic. Two authorizers, route-based selection.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `infra/lib/constructs/lambda-trpc.ts` | NEW | tRPC Lambda factory |
| `infra/lib/constructs/api-gw-http.ts` | NEW | HTTP API + routes + authorizers |
| `infra/lib/constructs/authorizers.ts` | NEW | Cognito JWT + PKI envelope authorizers |
| `packages/orchestrator/src/lambda/handlers/*.ts` | NEW | One handler per router group |
| `packages/orchestrator/src/lambda/lambda-trpc-adapter.ts` | NEW | Wraps tRPC router as Lambda handler |
| `packages/orchestrator/src/lambda/init.ts` | NEW | Cold-start init: secrets, DB, etc. cached in module scope |

## Lambda layout
One Lambda per logical router group for cold-start isolation:
- `auth` — login callbacks, refresh, sign-out
- `tasks` — tasks router
- `memory` — memory router
- `comms` — channels + messages
- `defects` — defects router
- `audit` — audit + replay
- `prs` — PR linkage
- `cost` — cost summary (read-only via hub; writes are local-only)
- `providers` — model provider mgmt
- `team` — known_installs, presence
- `onboarding` — onboarding router (Round 6 #11)

Each Lambda:
- Runtime: Node.js 22 (per CLAUDE.md user-global default; Orbital uses Node)
- Memory: 1024 MB (tunable)
- Timeout: 29s (under API GW 30s limit)
- Provisioned Concurrency: 2 instances for hot paths (`auth`, `tasks`); 0 for cold ones
- Environment: `ORBITAL_DEPLOY_TARGET=aws`, `ORBITAL_TENANT_RESOLUTION=jwt`, secrets ARNs
- IAM role: Aurora IAM auth, Secrets Manager get for own secrets, S3 for replay reads, SNS publish for event fanout

## Cold-start init pattern
```typescript
// init.ts — runs once per Lambda container
import { getSecrets } from './secrets-cache.js'
import { initDb } from '../db/client.js'

let initialized = false
let db: DB
let secrets: Secrets

export async function initOnce() {
  if (initialized) return { db, secrets }
  secrets = await getSecrets()  // Secrets Manager via SDK
  db = await initDb({ ...secrets.db, mode: 'aws' })  // RDS Proxy + IAM auth
  initialized = true
  return { db, secrets }
}
```

Handler files import this and call `await initOnce()` at the top. After cold start, subsequent invocations reuse the cached connection.

## tRPC over Lambda
Use `@trpc/server/adapters/aws-lambda`:
```typescript
import { awsLambdaRequestHandler } from '@trpc/server/adapters/aws-lambda'
import { tasksRouter } from '../trpc/routers/tasks.js'
import { initOnce } from './init.js'

export const handler = awsLambdaRequestHandler({
  router: tasksRouter,
  createContext: async ({ event }) => {
    await initOnce()
    return {
      db,
      secrets,
      tenantId: event.requestContext.authorizer?.lambda.tenantId,
      installId: event.requestContext.authorizer?.lambda.installId,
      userId: event.requestContext.authorizer?.lambda.userId,
    }
  },
})
```

## Authorizers

**Cognito JWT authorizer (`cognito-auth`):**
- API Gateway JWT authorizer pointed at Cognito issuer
- Audience: app client ID
- Used by: browser-initiated routes (`auth/`, `team/`, most user-facing reads)

**PKI envelope authorizer (`install-auth`):**
- Custom Lambda authorizer
- Reads `X-Orbital-Install-Id`, `X-Orbital-Sig`, `X-Orbital-Sig-Body` headers
- Verifies signature against `known_installs.public_key` from Aurora
- Returns context: `installId`, `tenantId`, `role`
- Used by: install-initiated routes (`tasks.claim`, `events.append`, `comms.post`)

API GW route configuration picks the authorizer per route. Some routes accept BOTH (e.g., audit reads — browser via Cognito, install via PKI both legitimate).

## API Gateway HTTP API
- Custom domain: `api.${envConfig.domain}`
- CORS configured for the UI origin (`https://${envConfig.domain}`)
- Throttling per route (default 100 req/sec, configurable)
- Request validation via OpenAPI annotations
- Logging to CloudWatch with structured access logs
- Stage: `$default`

## Acceptance criteria
1. After deploy, `curl https://api.mwitt.orbital.team.dev/health` returns 200 + JSON.
2. Authenticated request via Cognito JWT (test using a test user) round-trips to Aurora and returns data.
3. PKI envelope authorizer validates a signed envelope from a known install.
4. Cold start latency (p99) < 1.5s.
5. Warm latency (p99) < 200ms for `tasks.list`.
6. Provisioned Concurrency on hot paths verified in CloudWatch.
7. Tenant isolation: a JWT for tenant A cannot read tenant B's tasks (parameterized test).

## Hard-stop checks
```
grep -E "awsLambdaRequestHandler" packages/orchestrator/src/lambda/handlers/ -r
grep -E "CognitoJwtAuthorizer|HttpJwtAuthorizer" infra/lib/constructs/authorizers.ts
grep -E "PkiEnvelopeAuthorizer" infra/lib/constructs/authorizers.ts
ls packages/orchestrator/src/lambda/init.ts
```

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]`
