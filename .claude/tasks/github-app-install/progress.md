# GitHub App Install Flow — progress.md
[Engineer-Sr · Sonnet · run-github-app-install]

## Skill self-checks

- **aws-dsql-constraints**: No FKs, no SERIAL, no triggers. UUIDv7 for IDs. OCC retry on all mutating txns. DDL separate from DML. `clock_timestamp()` for defaults. Verified against existing schema.
- **multi-tenant-isolation**: tenant_id on every row; all queries scoped to ctx.tenantId; isolation tests added.
- **security-serverless**: Private key + webhook secret stay in Secrets Manager; never logged; installation tokens cached in-process only.
- **observability-aws**: structuredLog() via console.log → CloudWatch. token-refresh events logged.

## Risk Assessment: Medium
- New tRPC procedures: listRepos, getInstallationToken (additive, no schema changes)
- UI updates to GitHubTab and project create/edit (additive)
- Tests for tenant isolation, token refresh, repo cache

## What exists
- `githubInstallations`, `githubRepoBindings`, `githubWebhookDeliveries` tables — DONE
- `githubRouter` with `recordInstallation`, `listInstallations`, `bindRepo`, `listBindings` — DONE
- `InstallationTokenProvider` with in-process cache + single-flight — DONE
- `DefaultStoryExecutorGitHubClient` (full Git+PR contract) — DONE
- Webhook handler stores deliveries to `github_webhook_deliveries` — DONE
- `IntegrationsGitHub` page with manifest flow install button — DONE
- `GitHubCallback` page — DONE
- Routes wired in App.tsx — DONE

## What needs to be built (this task)
1. `github.listRepos(installationId)` — tRPC query, calls GET /installation/repositories with App token, 60s cache, tenant isolation
2. `github.getInstallationToken(installationId)` — tRPC query, returns token for App client calls at PR-creation time
3. `GitHubTab` in Settings → replace the old PAT-based UI with the App install flow + repo picker
4. Project create/edit: SCM provider=github → dropdown of repos from listRepos
5. Tests: token refresh (unit), repo list cache 60s TTL (unit), tenant isolation (unit)

## TDD Cycle
RED → GREEN → REFACTOR

## Deferred (out of scope)
- CDK deploy automation (deploy step described in task but requires human to run cdk deploy)
- GitHub Actions workflow changes (infra is already deployed per register-app-instructions.md)
- Stripe billing integration
