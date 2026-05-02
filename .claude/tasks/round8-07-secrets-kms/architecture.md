# Round 8-07 — Secrets Manager + KMS

## Persona / Risk
Engineer-Principal · Opus · Risk Tier: High · Estimate: M

(Risk High because secrets are blast-radius-large; getting IAM scoping wrong = secret leak across tenants.)

## Depends on
8-01 (CDK + IAM scaffolding), 8-02 (Aurora master creds need a home)

## Why
All secrets live in Secrets Manager; per-tenant CMKs in KMS for replay blob encryption. Lambdas get short-lived creds via IAM (no long-lived secrets).

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `infra/lib/constructs/secrets.ts` | NEW | Secrets + KMS keys + IAM policies |
| `infra/lib/constructs/per-tenant-kms.ts` | NEW | Custom resource that creates a CMK per tenant on tenant onboarding |
| `packages/orchestrator/src/lambda/secrets-cache.ts` | NEW | Module-scoped cache with TTL refresh |
| `packages/orchestrator/src/onboarding/tenant-kms.ts` | NEW | Onboarding step that creates CMK for new tenant |

## Secrets Manager: what's stored
**Per-env secrets:**
- `orbital/${env}/hub-master-key` — Ed25519 keypair for the hub itself (signing outbound, verifying inbound from installs)
- `orbital/${env}/db-master-creds` — Aurora master user creds (rotated)
- `orbital/${env}/github-webhook-secret` — for verifying inbound GitHub webhooks
- `orbital/${env}/cognito-app-client-secret` — if using OAuth code flow with client_secret
- `orbital/${env}/anthropic-key-shared` — OPTIONAL: a hub-level Anthropic key used ONLY for codebase analysis during onboarding (per-operator keys still preferred; this is fallback)

**Per-tenant secrets** (rare; most things are env-level):
- `orbital/${env}/tenant/${tenantId}/api-key-rotation-state` — for rotation pipelines

## Secret rotation
- DB master creds: 30-day rotation via Secrets Manager auto-rotation Lambda (RDS-built-in)
- Hub master key: 90-day rotation via custom Lambda; old key kept for verification of in-flight signed envelopes
- Cognito client secret: rotated annually
- Webhook secret: rotated on demand (UI button in admin)

## Per-tenant CMKs (KMS)
Each tenant gets its own KMS CMK:
- Used to encrypt replay blobs in S3 (Round 8-06)
- Used to encrypt sensitive PII fields in Aurora (jsonb event payloads where tenant marked them sensitive)
- Created on tenant onboarding (custom resource)
- Key alias: `alias/orbital-tenant-${tenantId}`
- Key policy: only the tenant's IAM principals (and Orbital's hub Lambdas) can use

When tenant deleted: CMK scheduled for deletion (30-day waiting period). All replay blobs encrypted with that CMK become unreadable — that's the point (right-to-erasure).

## IAM policies
Granular per-Lambda:
```json
{
  "Statement": [
    { "Effect": "Allow", "Action": "secretsmanager:GetSecretValue",
      "Resource": "arn:aws:secretsmanager:*:*:secret:orbital/mwitt/db-master-creds-*" },
    { "Effect": "Allow", "Action": "kms:Decrypt",
      "Resource": "arn:aws:kms:*:*:key/*",
      "Condition": { "StringLike": { "kms:RequestAlias": "alias/orbital-tenant-*" } } }
  ]
}
```

Each Lambda gets only the secrets it needs. The `tasks` Lambda doesn't need GitHub webhook secret. The `prs` Lambda doesn't need Anthropic key.

## Module-scoped cache
```typescript
// secrets-cache.ts
let cached: Secrets | null = null
let cachedAt = 0
const TTL_MS = 5 * 60_000

export async function getSecrets(): Promise<Secrets> {
  const now = Date.now()
  if (cached && (now - cachedAt) < TTL_MS) return cached
  const sm = new SecretsManagerClient({})
  const [dbCreds, hubKey, ...] = await Promise.all([
    sm.send(new GetSecretValueCommand({ SecretId: env.DB_CREDS_SECRET_ARN })),
    sm.send(new GetSecretValueCommand({ SecretId: env.HUB_KEY_SECRET_ARN })),
    // ...
  ])
  cached = parseSecrets({ dbCreds, hubKey })
  cachedAt = now
  return cached
}
```

After cold start, secrets are fetched once per Lambda container; refreshed every 5 minutes.

## Tenant onboarding integration
When a new tenant signs up (Round 8-04 flow or self-service Round 9), the onboarding handler:
1. Creates the CMK via KMS API
2. Sets the alias `alias/orbital-tenant-${tenantId}`
3. Updates the tenant's row in Aurora with `kms_cmk_arn`
4. Emits `TenantCmkProvisioned` event

## Acceptance criteria
1. Lambda calls Secrets Manager on cold start; subsequent invocations use cached value.
2. Manual rotation of db-master-creds → next Lambda cold start picks up new value (verified via test).
3. Per-tenant CMK created on tenant onboarding; alias resolves correctly.
4. IAM scope: a Lambda for tenant A cannot decrypt tenant B's replay blob (negative test).
5. Hub master key rotation: old key still verifies in-flight envelopes for up to 24h after rotation; new key signs outbound.
6. Audit: every Secret access logged in CloudTrail; per-tenant CMK access logged separately.

## Hard-stop checks
```
grep -E "SecretsConstruct|HubMasterKeySecret" infra/lib/constructs/secrets.ts
grep -E "GetSecretValueCommand" packages/orchestrator/src/lambda/secrets-cache.ts
grep -E "PerTenantCmk|alias/orbital-tenant" infra/lib/constructs/per-tenant-kms.ts
grep -E "TenantCmkProvisioned" packages/orchestrator/src/events/types.ts
```

## Persona evidence prefix
`[Engineer-Principal · Opus · run-round8-07-secrets-kms]`
