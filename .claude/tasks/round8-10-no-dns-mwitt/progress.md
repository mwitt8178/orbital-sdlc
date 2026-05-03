## DNS-conditional addition

**[Engineer-Sr · Sonnet · run-round8-10-no-dns-mwitt]**

### Files changed

| File | Change |
|---|---|
| `infra/cdk.json` | Added `"useCustomDomain": false` for `mwitt`; `"useCustomDomain": true` for `rreed` and `prod` |
| `infra/bin/orbital.ts` | Pass `useCustomDomain` from raw config to `envConfig` (default `true`) |
| `infra/lib/orbital-hub-stack.ts` | Added `useCustomDomain?: boolean` to `EnvConfig`; resolve flag (default `true`); pass to `DnsConstruct` + downstream constructs; added 3 generated-URL CfnOutputs (`CognitoAuthDomain`, `UiBucketName`, `CloudFrontDomain`) |
| `infra/lib/constructs/dns.ts` | Added `useCustomDomain?: boolean` prop; when `false`, skip HostedZone + ACM creation — `hostedZone` and `certificate` become `undefined` |
| `infra/lib/constructs/cognito.ts` | `hostedZone` prop changed to `IHostedZone | undefined`; Route53 A-record conditionally skipped when `hostedZone` is `undefined` |
| `infra/lib/constructs/api-gw-http.ts` | `certificate` and `hostedZone` props changed to nullable; `customDomain` property `DomainName | undefined`; custom domain + Route53 record skipped when `undefined`; `ApiEndpoint` output uses execute-api URL fallback; `disableExecuteApiEndpoint` only true in prod when custom domain is active |
| `infra/lib/constructs/api-gw-ws.ts` | `certificate` and `hostedZone` props changed to nullable; `customDomain` property `CfnDomainName | undefined`; custom domain + Route53 record skipped when `undefined`; `WsEndpoint` output uses execute-api WSS URL fallback |
| `infra/lib/constructs/static-ui.ts` | `certificate` and `hostedZone` props changed to nullable; `domainNames`/`certificate` on Distribution skipped when `undefined`; Route53 alias record skipped; `UiUrl` output uses `distributionDomainName` fallback |
| `infra/test/snapshot.test.ts` | Updated `buildStack` to pass `useCustomDomain: envName !== 'mwitt'`; rewrote `DnsConstruct` describe to assert mwitt has ZERO Route53/ACM and prod has them; updated Cognito Route53 A-record test; updated cdk-nag test; updated snapshots (2 updated) |
| `infra/test/static-ui.test.ts` | Updated `buildStack` to pass `useCustomDomain: envName !== 'mwitt'`; fixed CloudFront domain alias test; fixed TLS version test; fixed Route53 A-record test; updated cdk-nag test; updated snapshots (2 updated) |
| `infra/test/no-dns-mwitt.test.ts` | **NEW** — 19 tests: mwitt has zero Route53/ACM/custom domains; prod/rreed retain them; backwards compat (omitted flag defaults to true) |
| `infra/test/__snapshots__/api-gw-http.test.ts.snap` | Updated (disableExecuteApiEndpoint + ApiEndpoint output changed) |
| `infra/test/__snapshots__/api-gw-ws.test.ts.snap` | Updated (WsEndpoint output value changed for when useCustomDomain=false) |
| `infra/test/__snapshots__/replay-bucket.test.ts.snap` | Updated (full stack template changed for mwitt env) |
| `infra/test/__snapshots__/snapshot.test.ts.snap` | Updated (mwitt template: 374 → 364 resources; prod unchanged) |
| `infra/test/__snapshots__/static-ui.test.ts.snap` | Updated (mwitt CloudFront: no Aliases/cert; prod unchanged) |

### Diff of resource counts

| Env | Before | After | Delta | Route53 before | Route53 after | ACM before | ACM after |
|---|---|---|---|---|---|---|---|
| `mwitt` | 374 | 364 | -10 | >0 | **0** | >0 | **0** |
| `prod` | 377 | 377 | 0 | 5 | 5 | 1 | 1 |

The -10 resources on mwitt are: 1 HostedZone, 1 ACM Certificate, ~3 Route53 RecordSets (auth, api, ws, UI), 1 HTTP API DomainName, 1 WS API DomainName, 1 WS API Mapping, plus any associated CDK custom resource helpers for ACM DNS validation.

### Prod/rreed snapshot unchanged confirmation

- `prod`: 377 resources, 5 Route53, 1 ACM — identical to pre-change baseline.
- `rreed`: Not independently checked via synth (cross-region account lookup), but test suite (`no-dns-mwitt.test.ts` + `snapshot.test.ts`) confirms `useCustomDomain=true` path is intact and creates Route53 + ACM for rreed.

### Hard-stop check results

```
grep -E "useCustomDomain" infra/cdk.json infra/lib/orbital-hub-stack.ts | head -5  ✓
cdk synth --context env=mwitt | tail -3                                              ✓ (no errors)
cdk synth --context env=prod  | tail -3                                              ✓ (no code errors; STS lookup fail expected for fictional account)
grep -c "Type: AWS::Route53" (mwitt)                                                 0  ✓
grep -c "Type: AWS::CertificateManager" (mwitt)                                      0  ✓
npm test                                                                              398/398 passed, 22 snapshots matched
npx tsc --noEmit                                                                      clean (no output)
```

### Self-checks (per skill requirements)

- DSQL/OCC: No DSQL schema touched. N/A.
- Multi-tenant isolation: No tenant-scoped resources modified. N/A.
- Security: No IAM policy changes. Flag controls resource creation only; existing IAM is untouched.
- Observability: No CloudWatch alarm or dashboard changes. Generated-URL outputs added for operator visibility.
- Risk Tier: Medium. DNS-conditional gating is additive — `useCustomDomain` defaults to `true` preserving all existing behavior. The only risk is misconfiguring the flag, which is guarded by per-env explicit settings in `cdk.json`.

### Deferred

- rreed `cdk synth` was not independently run (different region + fictional account). The test suite validates rreed construct synthesis. Actual synth can be run when rreed AWS account credentials are available.

---

DEPLOY NOT EXECUTED — awaiting operator approval.

**Confidence: 97** — TypeScript clean, tsc clean, all 398 tests green, both mwitt hard-stop grep checks return 0, prod template unchanged at 377/5R53/1ACM.
