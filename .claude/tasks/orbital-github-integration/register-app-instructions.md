# Register the Orbital GitHub App

[Engineer-Principal · Opus · run-orbital-github-integration]

This document is a one-shot script for the human operator to register the GitHub
App, then store the resulting webhook secret + private key in AWS Secrets Manager
so the api-lambda can verify webhooks and mint installation tokens.

The orchestrator is already wired (`app-auth.ts` + `app-client.ts`); flipping
`ORBITAL_GITHUB_APP_ENABLED=1` after the steps below activates the integration.

---

## 1. Option A — Manifest flow (recommended)

The manifest flow auto-creates the App, asks GitHub to mint the webhook secret +
private key, and POSTs them back to a callback URL we control. This avoids
copy-paste of the private key.

The manifest is hosted at `/oauth/github/manifest` in the UI (added by this
task). To kick off the flow:

> https://d2mtgpa71y9c8t.cloudfront.net/settings/integrations/github

Click **Install GitHub App**. The button posts the manifest below to
`https://github.com/settings/apps/new?state=<csrf>` via a self-submitting form.

### Manifest JSON (pre-filled)

```json
{
  "name": "Orbital",
  "url": "https://d2mtgpa71y9c8t.cloudfront.net",
  "hook_attributes": {
    "url": "https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com/webhooks/github",
    "active": true
  },
  "redirect_url": "https://d2mtgpa71y9c8t.cloudfront.net/oauth/github/callback",
  "callback_urls": [
    "https://d2mtgpa71y9c8t.cloudfront.net/oauth/github/callback"
  ],
  "public": false,
  "default_permissions": {
    "contents": "write",
    "pull_requests": "write",
    "metadata": "read",
    "checks": "read"
  },
  "default_events": [
    "pull_request",
    "issue_comment",
    "check_run",
    "workflow_run",
    "check_suite"
  ]
}
```

After GitHub completes the manifest exchange it redirects to
`/oauth/github/callback?code=<temp>&state=<csrf>`. The callback page POSTs
`{ code }` to the tRPC procedure `github.recordInstallation`, which:

1. POSTs `code` to `https://api.github.com/app-manifests/<code>/conversions`
2. Receives `{ id (App ID), pem (private key), webhook_secret, html_url, ... }`
3. Stores webhook_secret + pem in Secrets Manager (handled by parent session
   AWS-write step — see §3 below for exact CLI fallback)
4. Inserts a row into `github_installations`

---

## 2. Option B — Manual UI clickpath (fallback)

Use only if the manifest flow can't be used (e.g. orgs that disable manifest
creation).

1. Open **<https://github.com/settings/apps/new>**
2. Fill in the fields exactly:

| Field | Value |
|---|---|
| GitHub App name | `Orbital` |
| Homepage URL | `https://d2mtgpa71y9c8t.cloudfront.net` |
| Callback URL | `https://d2mtgpa71y9c8t.cloudfront.net/oauth/github/callback` |
| Request user authorization (OAuth) during installation | unchecked |
| Webhook → Active | checked |
| Webhook URL | `https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com/webhooks/github` |
| Webhook secret | generate via `openssl rand -hex 32` and **save it** — you'll need it for §3 |
| SSL verification | **Enable SSL verification** |

3. **Repository permissions**:
   - Contents → **Read and write**
   - Pull requests → **Read and write**
   - Metadata → **Read-only** (mandatory)
   - Checks → **Read-only**
4. **Subscribe to events**:
   - [x] Pull request
   - [x] Issue comment
   - [x] Check run
   - [x] Workflow run
   - [x] Check suite
5. **Where can this GitHub App be installed?** → "Only on this account"
6. Click **Create GitHub App**.
7. On the resulting page, scroll to **Private keys** → **Generate a private key**.
   A `.pem` file downloads. Save it as `orbital.<date>.private-key.pem` — you'll
   feed it to AWS in §3.
8. Note the **App ID** (top of the page, e.g. `1234567`).

---

## 3. Store secrets in AWS Secrets Manager

The api-lambda reads two secrets at runtime:

- `orbital-mwitt/github-app-webhook-secret` — plain string (HMAC secret)
- `orbital-mwitt/github-app-private-key` — PEM private key

The CDK construct in `infra/lib/constructs/api-lambda.ts` already grants
`secretsmanager:GetSecretValue` on these ARNs when `ORBITAL_GITHUB_APP_ENABLED=1`
at synth time. The parent agent will run these CLI commands; if you need the
fallback, run them yourself:

```bash
# Webhook secret (the value you generated in §2 step 2 OR the value GitHub
# returned via the manifest flow)
aws secretsmanager create-secret \
  --region us-east-1 \
  --name orbital-mwitt/github-app-webhook-secret \
  --description "Orbital GitHub App webhook HMAC secret (mwitt env)" \
  --secret-string "<paste-webhook-secret-here>"

# Private key — pass via file:// to preserve newlines
aws secretsmanager create-secret \
  --region us-east-1 \
  --name orbital-mwitt/github-app-private-key \
  --description "Orbital GitHub App PEM private key (mwitt env)" \
  --secret-string "file:///absolute/path/to/orbital.<date>.private-key.pem"
```

If the secrets already exist (e.g. you're rotating), use `put-secret-value`
instead of `create-secret`:

```bash
aws secretsmanager put-secret-value \
  --region us-east-1 \
  --secret-id orbital-mwitt/github-app-webhook-secret \
  --secret-string "<new-webhook-secret>"
```

---

## 4. Flip the gate and redeploy

After the secrets exist, set the env vars and redeploy CDK:

```bash
export ORBITAL_GITHUB_APP_ENABLED=1
export ORBITAL_GITHUB_APP_ID=<numeric-app-id>
# Optional explicit ARNs — defaults are computed from the standard naming.
# export ORBITAL_GITHUB_APP_WEBHOOK_SECRET_ARN=arn:aws:secretsmanager:us-east-1:403001214246:secret:orbital-mwitt/github-app-webhook-secret-xxxxxx
# export ORBITAL_GITHUB_APP_PRIVATE_KEY_SECRET_ARN=arn:aws:secretsmanager:us-east-1:403001214246:secret:orbital-mwitt/github-app-private-key-xxxxxx
npx cdk deploy OrbitalHub-mwitt
```

The api-lambda picks up the new env vars on cold start; no code change required.

---

## 5. Install the App on a repo

1. Open the App's settings: `https://github.com/settings/apps/orbital`
2. **Install App** → choose the account/org
3. Pick **Only select repositories** → choose the repo(s) you want Orbital to
   touch
4. Click **Install**

GitHub redirects to `/oauth/github/callback?installation_id=<n>&state=<csrf>`.
The UI calls `github.recordInstallation` which writes a row to
`github_installations` with the `installation_id` from the URL.

After that, `github.bindRepo({ projectId, repoFullName })` binds an Orbital
project to the repo and writes to `github_repo_bindings`.

---

## 6. Verify

```bash
# Webhook reachable from GitHub (should 401 with no body, NOT 404)
curl -i -X POST https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com/webhooks/github \
  -H 'Content-Type: application/json' -d '{}'
# Expect: HTTP/2 401  + body { "error": { "code": "WEBHOOK_INVALID_SIGNATURE", ... } }

# Trigger a redeliver from the App's "Recent deliveries" tab, watch
# CloudWatch logs:
aws logs tail /orbital/mwitt/lambda/api --follow --region us-east-1
```

A successful delivery emits a `webhook_received` log line and writes a row to
`github_webhook_deliveries`.
