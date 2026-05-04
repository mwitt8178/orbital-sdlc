# Post-Deploy Smoke Gate

This gate catches the class of regression where unit tests and local E2E tests
all pass but the live deployed site is broken — for example, a Lambda 500 on a
flow-card click that only surfaces against real AWS infrastructure. It runs four
checks: the API health probe (`onboarding.status` at the API Gateway endpoint),
a clean load of `/welcome` with no console errors or >=400 responses, a
flow-card chooser assertion that confirms the three remaining flow cards
(`new_project`, `existing_repo`, `join_hub`) render and the removed
`sample_data` card does NOT render, and a final pass to assert no 5xx responses
fired during the full page lifecycle. Any single failure exits non-zero and
blocks the post-deploy CI step.

## Run locally

```bash
cd packages/ui
npx playwright test test/smoke --project=smoke
```

The tests default to `https://d2mtgpa71y9c8t.cloudfront.net`. Override with:

```bash
SMOKE_BASE_URL=https://your-cf-url.cloudfront.net \
SMOKE_API_URL=https://your-api-id.execute-api.us-east-1.amazonaws.com \
  npx playwright test test/smoke --project=smoke --reporter=list
```

To run headed for debugging:

```bash
npx playwright test test/smoke --project=smoke --headed
```

## CI trigger

The `.github/workflows/post-deploy-smoke.yml` workflow fires automatically via
`workflow_run` after either the `Deploy` or `UI Deploy` workflow succeeds on
`main`. It can also be triggered manually from the Actions tab with optional
URL overrides. Playwright HTML reports and test artifacts are uploaded on
failure (retained 7 days).
