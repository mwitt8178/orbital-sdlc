# Keychain on Aurora — Architecture

[Engineer-Principal · Opus · run-keychain-aurora]

## Bug

`TmpFileKeychain` writes `/tmp/orbital-keychain.json` per-Lambda-instance.
With provisioned concurrency >= 2, instance A holds the saved key, instance B does not.
Anthropic key-validation flow flaps for the user.

## Bounded contexts touched

- **orchestrator/capabilities/keychain** — new AuroraKeychain class, factory routes on
  `ORBITAL_DEPLOY_TARGET=aws`.
- **db** — new `tenant_credentials` table + Drizzle schema export.
- **infra (out-of-band)** — Secrets Manager secret `orbital-mwitt/keychain-master-key`
  + IAM allow on the api-lambda role.

## Aggregate boundary

`tenant_credentials(tenant_id, account)` is owned by the install/onboarding aggregate.
Encryption key (single per-install master AES-256 key) is opaque to the table — stored
in Secrets Manager and read once at process start.

## Storage shape

```
tenant_credentials
  tenant_id   uuid       NOT NULL
  account     text       NOT NULL
  ciphertext  bytea      NOT NULL  -- AES-256-GCM ciphertext of the secret
  iv          bytea      NOT NULL  -- 12-byte AES-GCM IV
  auth_tag    bytea      NOT NULL  -- 16-byte AES-GCM auth tag
  created_at  timestamptz NOT NULL DEFAULT now()
  updated_at  timestamptz NOT NULL DEFAULT now()
  PRIMARY KEY (tenant_id, account)
```

Aurora Serverless v2: no FK back to a tenants table (no such table at present;
`tenant_id` is the sentinel UUID in single-tenant staging). When a `tenants`
table lands, a follow-up migration can add a FK.

## Encryption

- Algorithm: AES-256-GCM (Node `crypto`, no third-party deps).
- IV: `crypto.randomBytes(12)` per write — never reused.
- AuthTag: 16 bytes, captured from cipher and stored alongside.
- Key: 32 raw bytes loaded once from Secrets Manager `orbital-mwitt/keychain-master-key`
  (binary value). Cached in memory per-Lambda-container.
- The secret is created out-of-band (manual `aws secretsmanager create-secret`) to
  avoid Lambda needing PutSecretValue in this iteration.

## Tenant scope

- AuroraKeychain is constructed per-call with a `tenantId` provided by the keychain
  factory `getKeychain(tenantId?)`.
- For backward compat, `getKeychain()` (no arg) defaults to
  `loadEnv().ORBITAL_HUB_TENANT_ID` (the per-install sentinel in local mode).
- All onboarding `connect.*` mutations run in `publicProcedure` (no tenant middleware
  yet) — they will pick up the env-default tenant. When the hub-mode tenant header
  becomes load-bearing for onboarding, callers can pass `ctx.tenantId` directly.

## IAM diff

api-lambda role (`OrbitalHub-mwitt-ApiLambdaRole7F72345A-ONw6zCfcZmk3`) needs:

```
{
  "Effect": "Allow",
  "Action": ["secretsmanager:GetSecretValue", "secretsmanager:DescribeSecret"],
  "Resource": "arn:aws:secretsmanager:us-east-1:<account>:secret:orbital-mwitt/keychain-master-key-*"
}
```

Added as an inline policy outside the CDK stack for this iteration; a follow-up
PR should fold this into `infra/lib/constructs/secrets.ts` so the secret is owned
by CDK like `hubMasterKeySecret`.

## Event flow

Unchanged. `AnthropicTokenStored`, `MondayTokenStored`, `GithubTokenStored` events
still emitted from onboarding router. The keychain.setPassword is now an
encrypted DB write instead of a `/tmp` write — semantics identical from the
caller's perspective.

## Blast radius

- Failure mode: secret missing → `getKeychain()` throws on first use; onboarding
  `connect.anthropic` returns `{ ok: false, message: 'Validated, but failed to
  store key in keychain.' }` (existing handler catches the error).
- Migration is purely additive (CREATE TABLE IF NOT EXISTS); no risk to existing
  data.
- Old `/tmp/orbital-keychain.json` data is intentionally NOT migrated — those
  keys were ephemeral by definition. Users re-paste their keys once.

## Rollback strategy

1. Flip api-lambda env: leave `ORBITAL_DEPLOY_TARGET=aws` but unset secret
   ARN (or remove IAM grant) → AuroraKeychain init throws → onboarding flips
   back to "key not validated" (visible regression, not data loss).
2. Hard rollback: `aws lambda update-alias` to a prior version that only knows
   `TmpFileKeychain`.
3. Schema: `DROP TABLE tenant_credentials;` (no other readers).

## Tests

- Unit: round-trip set/get/delete on AuroraKeychain (mocked db).
- Tenant-bleed: tenant T1 sets a key; tenant T2 cannot read it via getPassword.
- Idempotent set: writing the same account twice updates ciphertext (new IV) and
  the second read returns the second plaintext.
- Empty: getPassword on a missing account returns null.

## Confidence

70/100. The unknowns are (a) whether the IAM inline policy gets applied cleanly
without breaking the rest of the role, (b) whether the migration runner Lambda
picks up 0043 without conflicting with the parallel install-state agent
(coordinated by both taking the next free idx after the journal). These are
operational risks, not design risks.
