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

## Teardown (non-prod only)

```bash
# WARNING: destroys all resources including data. Use only on dev envs.
AWS_PROFILE=orbital-mwitt npm run destroy -- --context env=mwitt
```

Prod stack has termination protection enabled and will refuse to be destroyed without first disabling termination protection manually.

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
