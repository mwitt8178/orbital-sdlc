# AWS deployment drift diagnosis — `ORBITAL_HOME` missing from `orbital-mwitt-trpc-all`

**Status:** Diagnosed 2026-05-03. Hypothesis 1 confirmed.

## Hypothesis

The CDK source includes `ORBITAL_HOME: '/tmp/.orbital'` in the Lambda environment block at [infra/lib/constructs/lambda-trpc.ts:232](infra/lib/constructs/lambda-trpc.ts:232). The deployed function does not have it. The cause is **a stale `cdk.out/` artifact deployed by `cdk deploy` after a fresh synth was skipped**.

## Evidence

| Item | Value |
|---|---|
| `ORBITAL_HOME` line in source | `lambda-trpc.ts:232`, unconditional, applies to every `routerGroup` including `all` |
| Commit that introduced the line | `b04168f` (the pre-migration checkpoint) at 2026-05-03 10:13:07 CST |
| `cdk.out/OrbitalHub-mwitt.template.json` last synthesized | 2026-05-03 09:45:04 CST (28 min before the source change) |
| `grep -c ORBITAL_HOME cdk.out/OrbitalHub-mwitt.template.json` | **0** |
| Deployed Lambda `LastModified` | 2026-05-03T14:46:23Z |
| Conclusion | The `cdk deploy` at 14:46 used the 09:45 `cdk.out/` artifact directly without re-synth, so the template lacked `ORBITAL_HOME`. |

## Confirmation command

```bash
grep -c "ORBITAL_HOME" "/Users/matthewwitt/AI SDLC/orbital/infra/cdk.out/OrbitalHub-mwitt.template.json"
# Output: 0  → template predates the source change
```

## Recommended fix for Phase 1.8

For the Lambdas we keep (the new `api-lambda` and the existing `install` Lambda), the fix is:

```bash
cd infra && npx cdk deploy OrbitalHub-mwitt --require-approval never
# Re-synthesizes cdk.out from current source before deploying.
```

For the `trpc-all` Lambda specifically, this is moot because Phase 1 deletes it and replaces it with the lean `api-lambda` whose narrow router does not import `AgentOrgRepo` and therefore does not call `getOrbitalHome()`.

## Process fix to prevent recurrence

`cdk deploy` will re-synth automatically if invoked without `--app cdk.out`, but our deploy scripts may pin a pre-synthesized artifact. Phase 6 CI/CD pipeline (item 6.1) MUST run `cdk synth` immediately before `cdk diff`/`cdk deploy` in the same job, with no caching of `cdk.out/` between jobs. Document this requirement in the deploy runbook.
