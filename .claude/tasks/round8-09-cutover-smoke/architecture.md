# Round 8-09 — Cutover + Multi-env Smoke + Deploy Scripts

## Persona / Risk
Engineer-Principal · Opus · Risk Tier: High · Estimate: L

(Risk High because cutover involves data migration and DNS — getting it wrong = downtime or data loss.)

## Depends on
ALL prior 8-* tasks (this task validates them end-to-end)

## Why
Bring it home. Multi-env smoke that proves mwitt and rreed deploy in isolation; cutover playbook that moves a self-host hub to AWS without losing data; deploy/teardown scripts that make this routine.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `scripts/deploy-env.sh` | NEW | One-command deploy for any env |
| `scripts/teardown-env.sh` | NEW | One-command teardown for non-prod envs (with safety guards) |
| `scripts/cutover-from-self-host.sh` | NEW | Self-host → AWS migration script |
| `scripts/aws-smoke-test.sh` | NEW | End-to-end smoke against deployed env |
| `infra/test/e2e/{aws-cutover.e2e.test.ts,multi-env-isolation.e2e.test.ts}` | NEW | Programmatic smoke + isolation tests |
| `docs/aws-deployment.md` | extend | Cutover playbook section |
| `docs/aws-rollback.md` | NEW | Rollback procedures |

## Deploy script
```bash
#!/usr/bin/env bash
# scripts/deploy-env.sh <env>
set -euo pipefail
ENV="${1:?usage: deploy-env.sh <env>}"

# Sanity guard
if [[ "$ENV" == "prod" && "${ALLOW_PROD_DEPLOY:-}" != "1" ]]; then
  echo "Production deploy requires ALLOW_PROD_DEPLOY=1" >&2
  exit 1
fi

# Pre-flight
cd infra
npm ci
npm run synth -- --context env="$ENV"
echo "=== CDK diff ==="
npx cdk diff --context env="$ENV"

# Confirmation
if [[ "${ORBITAL_AUTO_APPROVE_DEPLOY:-}" != "1" ]]; then
  read -rp "Proceed with deploy? [y/N]: " confirm
  [[ "$confirm" == "y" ]] || exit 1
fi

# Deploy
npx cdk deploy --context env="$ENV" --require-approval never
echo "=== Smoke test ==="
../scripts/aws-smoke-test.sh "$ENV"
```

## Smoke test script
```bash
# scripts/aws-smoke-test.sh
ENV="${1:?usage}"
DOMAIN="$(jq -r ".context.envs.${ENV}.domain" infra/cdk.json)"

echo "1. Health endpoint..."
curl -fsS "https://api.${DOMAIN}/health" | jq .

echo "2. Cognito sign-up + sign-in (test user)..."
# uses awscli to create a test user, sign in, get JWT

echo "3. Authenticated tRPC call..."
JWT="..."
curl -fsS -H "Authorization: Bearer $JWT" "https://api.${DOMAIN}/trpc/team.members" | jq .

echo "4. WS connect + subscribe + receive..."
# Node script that opens WS, subscribes, triggers event, asserts receipt

echo "5. Replay capture roundtrip..."
# Trigger a fake LLM call → assert blob in S3 → read back → verify hash

echo "6. Event fanout..."
# Publish event → assert SQS consumer fired

echo "7. Alarm sanity..."
# Trigger a synthetic 5xx → assert alarm transitions to ALARM state

echo "✅ All smoke tests passed for env=${ENV}"
```

## Multi-env isolation test
A real-environment test that:
1. Deploys mwitt env
2. Deploys rreed env
3. Creates a tenant + data in mwitt
4. Verifies the same data is NOT in rreed (via direct DB query, S3 list, Cognito list)
5. Verifies mwitt's resources don't appear in rreed's CloudFormation

Runs as a periodic CI job (weekly), not on every PR — too expensive.

## Cutover playbook
Step-by-step for moving a running self-host Orbital hub to AWS:

1. **Pre-cutover (1 day before):**
   - Deploy AWS env via `deploy-env.sh`
   - Verify smoke tests pass
   - Lower self-host DNS TTL to 60s
   - Schedule maintenance window (15 min)

2. **Cutover window:**
   - Set self-host hub to read-only mode (new flag: `ORBITAL_HUB_READONLY=1`)
   - Run `pg_dump` from self-host Postgres
   - Restore dump to Aurora via psql (through bastion or VPN)
   - Verify event count matches between source and target
   - Update DNS A/CNAME to AWS API Gateway/CloudFront
   - Wait for DNS propagation (30-60s with low TTL)
   - Smoke test the new endpoint

3. **Verify:**
   - All operators reconnect (signed envelope auth still works — same install_id, same pubkey)
   - In-flight WS subscriptions re-establish
   - Sample 10 random events: verify content matches between source and target
   - Watch alarms for 24h

4. **Decommission self-host (after 7-day soak):**
   - Stop the self-host process
   - Archive the local Postgres dump to encrypted offsite
   - Tear down docker-compose

Rollback procedure: revert DNS, restart self-host hub. 5-minute rollback window for the first 24h.

## Teardown script (non-prod only)
```bash
# scripts/teardown-env.sh <env>
ENV="${1:?usage}"
[[ "$ENV" == "prod" ]] && { echo "REFUSE: prod teardown not via this script"; exit 1; }

read -rp "Type the env name to confirm teardown ($ENV): " confirm
[[ "$confirm" == "$ENV" ]] || exit 1

cd infra
npx cdk destroy --context env="$ENV" --force
```

Production teardown requires manual procedure documented in `docs/aws-rollback.md`.

## Acceptance criteria
1. `./scripts/deploy-env.sh mwitt` deploys cleanly from a fresh repo + AWS account.
2. `./scripts/aws-smoke-test.sh mwitt` passes all 7 checks.
3. `./scripts/deploy-env.sh rreed` deploys to a different region/account; multi-env isolation test passes.
4. Cutover playbook walked through on a test self-host → AWS migration; data verified post-cutover.
5. Rollback procedure tested: post-cutover, revert DNS, self-host operates.
6. `./scripts/teardown-env.sh mwitt` cleanly removes all resources (verified by `aws cloudformation list-stacks` returning no orbital stacks).
7. Documentation: a non-engineer team member can deploy and teardown an env using only the docs.

## Hard-stop checks
```
ls scripts/deploy-env.sh scripts/teardown-env.sh scripts/aws-smoke-test.sh scripts/cutover-from-self-host.sh
ls docs/aws-deployment.md docs/aws-rollback.md
ls infra/test/e2e/aws-cutover.e2e.test.ts infra/test/e2e/multi-env-isolation.e2e.test.ts
```

## Operator approval gates
- `cdk deploy` runs only with explicit confirmation OR `ORBITAL_AUTO_APPROVE_DEPLOY=1`
- Production deploy requires `ALLOW_PROD_DEPLOY=1` AND interactive confirmation
- Production teardown is NOT in this script — manual procedure only

## Persona evidence prefix
`[Engineer-Principal · Opus · run-round8-09-cutover-smoke]`
