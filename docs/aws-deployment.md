# Orbital AWS Deployment Guide

This guide walks an engineer from zero to a fully deployed Orbital Hub in one environment (target: under 30 minutes once prerequisites are met).

## Environments

| Name | Domain | Region | Account | Purpose |
|---|---|---|---|---|
| `mwitt` | mwitt.orbital.team.dev | us-east-1 | TBD | Matt's dev env |
| `rreed` | rreed.orbital.team.dev | us-west-2 | TBD | Ryan's dev env |
| `prod` | orbital.team.dev | us-east-1 | TBD | Production |

Each env is a completely isolated CloudFormation stack (`OrbitalHub-<env>`). No data crosses between envs.

---

## Prerequisites

### 1. AWS Account + CLI

You need an AWS account per env (or you can share one account across envs with separate regions — not recommended for prod).

```bash
# Install AWS CLI v2
brew install awscli

# Configure credentials (use named profiles per env)
aws configure --profile orbital-mwitt
# Enter: Access Key ID, Secret Access Key, Region (us-east-1), Output (json)

# Verify
aws sts get-caller-identity --profile orbital-mwitt
```

For CI/CD, use IAM roles with OIDC federation rather than long-lived access keys.

### 2. Node.js 22+

```bash
node --version  # must be >= 22.0.0
```

### 3. CDK CLI

```bash
npm install -g aws-cdk
cdk --version  # tested with 2.178.x
```

### 4. CDK Bootstrap (once per account/region)

CDK bootstrap creates the S3 bucket and IAM roles that CDK uses to store assets:

```bash
# For mwitt env (us-east-1)
AWS_PROFILE=orbital-mwitt cdk bootstrap aws://<ACCOUNT_ID>/us-east-1

# For rreed env (us-west-2)
AWS_PROFILE=orbital-rreed cdk bootstrap aws://<ACCOUNT_ID>/us-west-2

# For prod (us-east-1)
AWS_PROFILE=orbital-prod cdk bootstrap aws://<ACCOUNT_ID>/us-east-1
```

Bootstrap only needs to run once per account/region. Re-running is idempotent.

### 5. Domain Registration

Each env needs its domain registered or delegated in Route 53:

- `mwitt.orbital.team.dev` — subdomain of `orbital.team.dev`
- `rreed.orbital.team.dev` — subdomain of `orbital.team.dev`
- `orbital.team.dev` — apex domain (prod)

If using a pre-existing hosted zone, set `ORBITAL_HOSTED_ZONE_ID` before synth/deploy:

```bash
export ORBITAL_HOSTED_ZONE_ID=Z1234567890ABC
```

Otherwise CDK will create a new hosted zone and output the NS records for delegation.

### 6. (Optional) OAuth Provider Credentials

To enable Google or Microsoft login, set these before synth:

```bash
# Google OAuth app (from https://console.cloud.google.com/apis/credentials)
export ORBITAL_GOOGLE_CLIENT_ID=<your-client-id>
export ORBITAL_GOOGLE_CLIENT_SECRET=<your-client-secret>

# Microsoft OAuth app (from https://portal.azure.com/#blade/Microsoft_AAD_RegisteredApps)
export ORBITAL_MS_CLIENT_ID=<your-client-id>
export ORBITAL_MS_CLIENT_SECRET=<your-client-secret>
```

If not set, only email/password auth is configured. IdPs can be added later by re-synth with the vars set.

---

## Account ID Setup

Account IDs are `<TBD>` in `cdk.json`. Set them before deploying — either:

**Option A: Environment variables (recommended for CI)**

```bash
export ORBITAL_ACCOUNT_MWITT=111111111111
export ORBITAL_ACCOUNT_RREED=222222222222
export ORBITAL_ACCOUNT_PROD=333333333333
```

**Option B: Update cdk.json directly (for local dev)**

Edit `infra/cdk.json` and replace the `<TBD>` values in the `envs` block with real account IDs. Do not commit real account IDs to source control.

---

## Deploy Steps

### Step 1: Install infra dependencies

```bash
cd infra
npm install
```

### Step 2: Synthesize (verify template, no AWS calls)

```bash
# From infra/ directory
npm run synth -- --context env=mwitt

# From repo root
npm run infra:synth -- --context env=mwitt
```

Successful synth produces a CloudFormation template in `infra/cdk.out/OrbitalHub-mwitt.template.json`. No AWS credentials required.

### Step 3: Diff (see what will be created — needs creds)

```bash
AWS_PROFILE=orbital-mwitt npm run diff -- --context env=mwitt
```

On first deploy against an empty account, this shows all resources being added.

**Expected diff for 8-01 (VPC + Cognito + DNS only):**
- ~49 resources (mwitt/rreed), ~51 resources (prod)
- Key categories:
  - VPC + 6 subnets + NAT GW + IGW + flow logs
  - 3 VPC endpoints (S3 gateway, Secrets Manager interface, KMS interface)
  - Route 53 hosted zone + ACM wildcard certificate
  - Cognito user pool + app client + hosted UI domain
  - Route 53 A-record for auth subdomain

### Step 4: Operator Approval

Review the diff output. The CDK code provisions real AWS resources that incur cost.

**Estimated monthly cost for one env (8-01 resources only):**
| Resource | Est. Monthly Cost |
|---|---|
| VPC + NAT GW (1 for dev, 2 for prod) | $32 (dev) / $64 (prod) |
| VPC Interface Endpoints (Secrets Mgr + KMS) | ~$15 |
| ACM certificate | Free |
| Route 53 hosted zone | $0.50 |
| Cognito (≤50 MAU) | Free |
| **Total (8-01 only)** | **~$48 (dev) / ~$80 (prod)** |

Full stack cost estimate (all 8 sub-tasks) is in `/Users/matthewwitt/AI SDLC/orbital/.claude/tasks/round8-aws-migration/architecture.md` (~$90/mo per env).

### Step 5: Deploy

```bash
# REQUIRES OPERATOR EXPLICIT APPROVAL — provisions billable AWS resources
AWS_PROFILE=orbital-mwitt npm run deploy -- --context env=mwitt --require-approval never

# Or interactively (will prompt for IAM/security group changes):
AWS_PROFILE=orbital-mwitt npm run deploy -- --context env=mwitt
```

The deploy takes ~15-20 minutes for a fresh account (ACM DNS validation is the slowest step).

### Step 6: Verify

After deploy completes:

```bash
# Confirm user pool exists
aws cognito-idp list-user-pools --max-results 5 --region us-east-1 --profile orbital-mwitt
# Expected: orbital-mwitt pool in results

# Confirm hosted zone exists
aws route53 list-hosted-zones --profile orbital-mwitt
# Expected: mwitt.orbital.team.dev. zone present

# Confirm cert is issued (DNS validation complete)
aws acm list-certificates --region us-east-1 --profile orbital-mwitt
# Expected: cert for mwitt.orbital.team.dev with status ISSUED

# Confirm VPC
aws ec2 describe-vpcs --filters "Name=tag:Name,Values=orbital-mwitt" --region us-east-1 --profile orbital-mwitt
```

---

## DNS Delegation (if new hosted zone created)

When CDK creates a new hosted zone, the `NameServers` output contains the NS records you must add to the parent zone.

```bash
# Get NS records from stack outputs
aws cloudformation describe-stacks \
  --stack-name OrbitalHub-mwitt \
  --region us-east-1 \
  --profile orbital-mwitt \
  --query "Stacks[0].Outputs[?OutputKey=='DnsNameServers'].OutputValue" \
  --output text
```

Add those 4 NS records to your parent zone (where `orbital.team.dev` is managed). Until delegation propagates, ACM certificate validation will be pending.

**If you own `orbital.team.dev` in another Route 53 account:**

1. Note the NS records from the output
2. In the account managing `orbital.team.dev`, add NS records pointing to the output values
3. Wait for propagation (up to 48h, usually minutes)

---

## Cognito Hosted UI

After a successful deploy, the Cognito hosted UI is available at:

```
https://orbital-<envName>.auth.us-east-1.amazoncognito.com
```

The `auth.<domain>` A-record points to the Cognito CloudFront distribution for the custom domain experience.

**Test sign-up flow:**
```
https://orbital-mwitt.auth.us-east-1.amazoncognito.com/signup?
  client_id=<APP_CLIENT_ID>&
  response_type=code&
  scope=openid+email+profile&
  redirect_uri=https://mwitt.orbital.team.dev/auth/callback
```

App client ID is in the stack outputs:
```bash
aws cloudformation describe-stacks \
  --stack-name OrbitalHub-mwitt \
  --query "Stacks[0].Outputs[?OutputKey=='CognitoAppClientId'].OutputValue" \
  --output text \
  --region us-east-1 --profile orbital-mwitt
```

---

## One-command Deploy + Teardown (Round 8-09)

Once prereqs are in place, the deploy/teardown lifecycle is two scripts:

### `scripts/deploy-env.sh <env>`

```bash
# Interactive: prompts for confirmation after showing the cdk diff
AWS_PROFILE=orbital-mwitt ./scripts/deploy-env.sh mwitt

# Non-interactive (CI):
ORBITAL_AUTO_APPROVE_DEPLOY=1 AWS_PROFILE=orbital-mwitt ./scripts/deploy-env.sh mwitt

# Production: requires the explicit guardrail flag + double confirmation
ALLOW_PROD_DEPLOY=1 AWS_PROFILE=orbital-prod ./scripts/deploy-env.sh prod
```

What it does:
1. Validates the env name (mwitt | rreed | prod).
2. Refuses prod unless `ALLOW_PROD_DEPLOY=1`.
3. Verifies `node`, `npm`, `aws`, `npx` are on PATH and Node >= 22.
4. Runs `aws sts get-caller-identity` to confirm credentials.
5. Runs `npm ci` then `cdk synth` (no AWS calls).
6. Runs `cdk diff` so the operator sees exactly what will change.
7. Prompts for confirmation (skipped if `ORBITAL_AUTO_APPROVE_DEPLOY=1`).
8. Runs `cdk deploy --context env=<env> --require-approval never` and writes outputs to `infra/cdk.out/outputs-<env>.json`.
9. Runs `scripts/aws-smoke-test.sh <env>` (skip with `ORBITAL_SKIP_SMOKE=1`).

### `scripts/teardown-env.sh <env>`

```bash
# Interactive only — there is no auto-approve for teardown
AWS_PROFILE=orbital-mwitt ./scripts/teardown-env.sh mwitt
```

What it does:
1. Refuses if `env=prod`. Production teardown is a manual procedure documented in `docs/aws-rollback.md` (Production Teardown).
2. Cross-checks that `aws sts get-caller-identity` returns the same account as the env config in `cdk.json` (refuses if mismatched).
3. Requires the operator to retype the env name AND type the word `destroy`.
4. Runs `cdk destroy --context env=<env> --force`.
5. Verifies no `OrbitalHub-<env>` stack remains in CloudFormation.

Note: Aurora final snapshots, CloudWatch logs, and (in prod) ObjectLocked S3 objects are retained per their individual retention policies; teardown does not delete them.

---

## Smoke Test (`scripts/aws-smoke-test.sh`)

Runs 7 end-to-end health checks against a deployed env:

| # | Check |
|---|---|
| 1 | `GET /health` returns 200 |
| 2 | Cognito sign-up + sign-in produces a valid IdToken (uses `admin-create-user` + `admin-initiate-auth`; throwaway user is deleted after) |
| 3 | Authenticated tRPC `GET /trpc/team.members` returns 200 with the JWT from check 2 |
| 4 | WebSocket `wss://ws.<domain>/`: connect → subscribe → receive within timeout |
| 5 | Replay capture roundtrip: PUT a JSON blob to the replay bucket, GET it back, assert SHA-256 match |
| 6 | SNS publish → SQS receive: publish a smoke event, poll the audit-indexer queue, assert the event is delivered |
| 7 | CloudWatch alarms with prefix `orbital-<env>-` exist and are queryable |

Usage:

```bash
./scripts/aws-smoke-test.sh mwitt

# Skip specific checks (e.g., 2 and 4 for environments where Cognito or WS aren't ready):
ORBITAL_SMOKE_SKIP_LIST=2,4 ./scripts/aws-smoke-test.sh mwitt
```

The smoke deletes the throwaway Cognito user on exit (via a bash trap). All other resources remain.

---

## Cutover Playbook — Self-Host Hub → AWS

Cutover migrates an existing Round 7 self-host Orbital Hub (Postgres in Docker) to its AWS counterpart. The playbook below assumes the AWS env (`mwitt` here) has already been deployed via `deploy-env.sh` and that smoke checks pass.

**Risk Tier: High — getting cutover wrong = downtime or data loss.**

### Pre-cutover (1 day before)

1. Deploy AWS env via `deploy-env.sh mwitt` and confirm `aws-smoke-test.sh mwitt` is green.
2. Lower the self-host DNS TTL on the existing record. The current record will be referenced by every operator's local install. Lower TTL to 60 seconds at least 24h before cutover so caches drain.
   ```bash
   # Example (Cloudflare):
   curl -X PATCH "https://api.cloudflare.com/client/v4/zones/<zoneid>/dns_records/<recordid>" \
     -H "Authorization: Bearer ${CF_TOKEN}" \
     -H "Content-Type: application/json" \
     --data '{"ttl":60}'
   ```
3. Schedule a maintenance window. Typical cutover takes 5–15 minutes depending on data size.
4. Notify operators: brief unavailability + their `orbital` CLI may need a `orbital reconnect` after.
5. Test the cutover script in `--dump-only` mode against a staging copy.

### Cutover window

```bash
# Required env vars
export AWS_PROFILE=orbital-mwitt
export ORBITAL_HUB_URL=https://hub.example.com
export ORBITAL_HUB_OWNER_TOKEN=<owner-token>
export ORBITAL_SELFHOST_PG_URL=postgres://orbital:<pw>@localhost:5433/orbital_hub
export ORBITAL_AURORA_PG_URL=postgres://admin:<pw>@orbital-mwitt-rds-proxy.proxy-...rds.amazonaws.com:5432/orbital_hub

# Run the cutover (interactive — confirms before each destructive step)
./scripts/cutover-from-self-host.sh mwitt
```

The script walks these steps automatically:

1. **Set self-host hub to read-only mode.** Calls `POST /admin/readonly { "readonly": true }`. This makes the `EVENT_APPEND` path return 503 to clients; reads still work. If your hub doesn't support that endpoint yet, set `ORBITAL_HUB_READONLY=1` in its `.env` and restart the container manually, then re-run with `--skip-readonly`.
2. **`pg_dump` the self-host Postgres** to `backups/cutover/orbital-cutover-<env>-<ts>.sql`. Source row count for the `events` table is captured to `<file>.events-count` for verification.
3. **Restore the dump into Aurora via psql.** Restore is wrapped in a single transaction (`--single-transaction`) so a partial load rolls back cleanly. Aurora DSQL hard-no rules (no FKs, no sequences, no triggers) apply — the dump should not contain those because Round 7 schema already follows DSQL conventions.
4. **Verify event count parity.** If source != target, the script aborts with exit 5 and the DNS cutover should NOT proceed.
5. **Print DNS cutover instructions.** The script does not flip DNS automatically — that step is operator-driven so you can timebox the propagation window precisely.

### DNS cutover

Get the AWS endpoint:

```bash
aws cloudformation describe-stacks \
  --stack-name OrbitalHub-mwitt \
  --query "Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue" \
  --output text
# → d-abc123.execute-api.us-east-1.amazonaws.com (or the custom domain)
```

Update your DNS provider:

```
hub.example.com   CNAME   <api-endpoint>   TTL=60
```

Wait 30–60 seconds for propagation. Verify:

```bash
dig +short hub.example.com
# Should resolve to the new endpoint
```

Run the smoke against the new endpoint:

```bash
./scripts/aws-smoke-test.sh mwitt
```

### Verify post-cutover

1. **Operators reconnect.** Existing Round 7 PKI signed envelopes still work because the install_id and pubkey haven't changed; the hub is just at a new IP.
2. **WS subscriptions re-establish.** Browser clients holding a Cognito session must re-acquire WS tokens; CLI installs automatically reconnect via `wss://ws.<domain>`.
3. **Sample events match.** Compare 10 random `event_id` values between source (read-only) and target:
   ```bash
   psql "$ORBITAL_SELFHOST_PG_URL" -At \
     -c "SELECT event_id FROM events ORDER BY random() LIMIT 10" \
     | while read id; do
         echo -n "$id  src="
         psql "$ORBITAL_SELFHOST_PG_URL" -At -c "SELECT md5(content::text) FROM events WHERE event_id='$id'"
         echo -n "          tgt="
         psql "$ORBITAL_AURORA_PG_URL" -At -c "SELECT md5(content::text) FROM events WHERE event_id='$id'"
       done
   ```
4. **Watch alarms for 24h.** CloudWatch alarms (5xx rate, Lambda errors, SQS DLQ depth, Aurora CPU, RDS Proxy connection-pool exhaustion) should remain in `OK`.

### Decommission self-host (after 7-day soak)

Only after 7 days of clean operation on AWS:

```bash
# Stop the self-host container
docker compose -f docker-compose.hub.yml down

# Archive the local Postgres dump to encrypted offsite storage
aws s3 cp \
  ./backups/cutover/orbital-cutover-mwitt-<ts>.sql \
  s3://orbital-archive/cutovers/ \
  --sse aws:kms --sse-kms-key-id alias/orbital-archive

# Tear down docker-compose
docker compose -f docker-compose.hub.yml rm -f
```

Keep the dump file at least one year for forensics + regulatory compliance.

### Rollback (within 5 minutes of DNS cutover)

If post-cutover smoke fails:

1. Revert DNS — point `hub.example.com` back at the self-host IP.
2. Set `ORBITAL_HUB_READONLY=0` in the self-host `.env` and restart the container.
3. The `events` written to AWS during the brief AWS-active window must be replayed back. See `docs/aws-rollback.md` section "Cutover rollback".

The 5-minute window is constrained by the original DNS TTL (60s) plus a margin for resolver caches.

---

## Teardown (non-prod only)

Use the deploy script's companion:

```bash
# WARNING: destroys all resources including data. Use only on dev envs.
AWS_PROFILE=orbital-mwitt ./scripts/teardown-env.sh mwitt
```

Or the underlying CDK command if you have a non-standard need:

```bash
AWS_PROFILE=orbital-mwitt npm run destroy -- --context env=mwitt
```

Prod stack has termination protection enabled and will refuse to be destroyed without first disabling termination protection manually. See `docs/aws-rollback.md` for the production teardown procedure.

---

## Troubleshooting

### ACM certificate stuck in "Pending validation"

DNS validation requires the CNAME record to be resolvable. Check:
1. Hosted zone NS records are delegated from parent zone
2. DNS propagation completed (`dig mwitt.orbital.team.dev NS`)
3. ACM-created CNAME records exist in the hosted zone

### `cdk bootstrap` required

If deploy fails with "Need to perform AWS calls for account ... but no credentials", run bootstrap first (see Step 1 above).

### `<TBD>` account ID in synth warnings

Synth with `<TBD>` account works but uses `CDK_DEFAULT_ACCOUNT` (your current AWS profile's account). Set `ORBITAL_ACCOUNT_<ENV>` env vars or update `cdk.json` before deploying to the correct target account.

### Node version warning from JSII

CDK's JSII runtime warns about Node v25. Suppress with:
```bash
export JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1
```

This is cosmetic — the CDK code runs correctly on v25.

---

## Running Tests

```bash
# From infra/
npm test

# From repo root
npm run infra:test

# Update snapshots after intentional template changes
cd infra && npx jest --updateSnapshot
```

Tests include:
- 31 property assertions (VPC, DNS, Cognito, stack-level)
- cdk-nag AwsSolutionsChecks (no ERROR violations)
- 2 full CFN template snapshots (mwitt + prod)
