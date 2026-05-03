# Pre-deploy validation framework + schema-error sweep

[Engineer-Principal · Opus · run-round8-pre-deploy-validation]

## Persona / Risk

Engineer-Principal · Opus · Risk Tier: High · Estimate: XL

Risk-High because:
1. Deploy reliability is operationally critical. Two consecutive deploys to mwitt have failed mid-CFN with schema-validation errors. Each failure burns ~25 min, leaves the stack in `ROLLBACK_COMPLETE`, and requires human re-trigger.
2. Wiring `cdk deploy --no-execute` into the standard deploy path changes the trust contract for the deploy script. Operators must continue to be able to run `scripts/deploy-env.sh prod` with the same confidence.
3. The em-dash sweep modifies `description`/`comment`/`alarmDescription` strings on dozens of resources. Most are cosmetic, but a wrong replacement could change a logical name or break a CDK construct's expectations.

## Why

The current loop is:
1. Operator runs `scripts/deploy-env.sh mwitt`
2. `cdk synth` passes (TypeScript-level)
3. `cdk diff` runs (no validation against CFN schema)
4. `cdk deploy` starts; CFN begins provisioning resources in parallel
5. AWS API rejects 1-3 specific resources with regex/parameter validation errors
6. CFN cancels the entire stack (no transactional rollback for never-created resources)
7. Operator fixes one error, retries; surfaces a different error
8. Repeat

The root cause: synth-time validation is permissive (TS types accept `any` for L1 constructs, accept Latin-1 for descriptions, accept gzip+nocache combos). Schema-level validation only happens at deploy time, on the CFN side, sequentially as resources are created.

The fix is a static + AWS-side pre-deploy validation layer that surfaces *all* schema errors before any resource is provisioned.

## Bounded contexts touched

| Context | Files | Change |
|---|---|---|
| Deploy scripts | `scripts/pre-deploy-validate.sh` | NEW. Pipeline runner. |
| Deploy scripts | `scripts/cycle-check.ts` | NEW. Tarjan SCC on CFN template. |
| Deploy scripts | `scripts/deploy-env.sh` | EDIT. Inserts pre-deploy-validate before `cdk diff`. |
| `.gitignore` | EDIT. Add `.venv-cfn-lint/`. |
| Infra constructs | All `infra/lib/constructs/*.ts` and `infra/lib/orbital-hub-stack.ts` | EDIT. Replace em-dashes (U+2014) and en-dashes (U+2013) with ASCII `-` in CFN-bound `description`, `comment`, `Description`, `alarmDescription`, `displayName`, `markdown` strings. |
| Infra constructs | `infra/lib/constructs/static-ui.ts` | EDIT. Remove `enableAcceptEncodingGzip` + `enableAcceptEncodingBrotli` from `noCachePolicy` (incompatible with `defaultTtl: 0`). |
| Infra constructs | `infra/lib/constructs/waf.ts` | EDIT. `singleHeader: { name: 'user-agent' }` -> `singleHeader: { Name: 'user-agent' }` (CFN schema requires PascalCase; the CDK L1 type is `any` so the field passes through unmodified). |
| Test snapshots | `infra/test/__snapshots__/*.snap` | REGENERATE. Em-dash sweep changes resource descriptions. |
| Lambda runtime code | `infra/lib/lambdas/*/index.ts` | LEAVE ALONE for em-dashes — comments only, never reach CFN. |

## CFN schema patterns enforced (from cfn-lint output)

| Resource | Property | Regex | Notes |
|---|---|---|---|
| `AWS::IAM::Role` | `Description` | `^[	
 -~¡-ÿ]*$` | ASCII + Latin-1 only. Em-dash (U+2014) outside Latin-1. |
| `AWS::EC2::SecurityGroup` | `GroupDescription` | `^([a-z,A-Z,0-9,. _\-:/()#,@[\]+=&;\{\}!$*])*$` | Limited ASCII set. No em-dash. |
| `AWS::WAFv2::WebACL` | `Description` | `^[a-zA-Z0-9=:#@/\-,.][a-zA-Z0-9+=:#@/\-,.\s]+[a-zA-Z0-9+=:#@/\-,.]{1,256}$` | First and last char must be alphanumeric or limited punctuation. No em-dash. No trailing space. |
| `AWS::WAFv2::WebACL` | `Rules[].Statement.NotStatement.Statement.SizeConstraintStatement.FieldToMatch.SingleHeader.Name` | required, PascalCase | CDK L1 typed as `any` — silently emits `name` (lowercase). |
| `AWS::CloudFront::CachePolicy` | `ParametersInCacheKeyAndForwardedToOrigin.EnableAcceptEncodingGzip` | only valid if caching enabled | When `MaxTTL=0` and `MinTTL=0`, gzip must be omitted (or false). |

## Validation pipeline (scripts/pre-deploy-validate.sh)

```
input: env name (mwitt | rreed | prod)
output: 0 (clean) | non-zero (fail with breakdown)

stages, fail-fast:

1. cdk synth --context env=$ENV
   -> output: cdk.out/OrbitalHub-$ENV.template.json
   -> failure mode: TS / cdk-nag / synthesis errors

2. cfn-lint cdk.out/OrbitalHub-$ENV.template.json
   -> catches: regex violations on string properties, missing required props,
              unexpected props, deprecated runtimes (warning only, non-blocking),
              unused DependsOn (warning only)
   -> failure mode: schema violation -> exit 1

3. npx tsx scripts/cycle-check.ts cdk.out/OrbitalHub-$ENV.template.json
   -> Tarjan SCC over Resources graph (Ref + Fn::GetAtt + DependsOn edges)
   -> failure mode: any SCC with > 1 resource -> exit 1

4. cdk deploy --context env=$ENV --no-execute --require-approval never
   -> creates a real CFN changeset; CFN validates the full template against AWS schema
      WITHOUT provisioning anything
   -> failure mode: CFN rejects the changeset -> exit 1
   -> cleanup: deletes the changeset to avoid stack-pending limbo

each stage runs only if prior stage passed; a failed stage prints actionable error context.
```

## Aggregate boundaries

No domain aggregates — this is infra-level. The bounded context is "deployable CDK template".

## Event flow

No events. Synchronous shell pipeline.

## IAM diff

No IAM-policy changes. The em-dash sweep only changes `description` strings on existing IAM roles. Role permissions, trust policies, and managed-policy attachments are unchanged.

## DSQL schema diff

None.

## Blast radius

- pre-deploy-validate.sh: zero blast radius. Read-only against AWS (changeset creation requires `cloudformation:CreateChangeSet` and `cloudformation:DeleteChangeSet`, scoped to the target stack only). The `--no-execute` flag guarantees no resource provisioning.
- em-dash sweep: zero functional blast radius. Resource descriptions are metadata-only; AWS uses them for display in console UIs and nothing else. Changing a `GroupDescription` on an `AWS::EC2::SecurityGroup` triggers a CFN replacement of the SG (immutable property), but the SG is at run-time the same — same allowed_sg, same ports, same ingress/egress rules. Aurora and Lambda traffic continues uninterrupted on the new SG.
- CachePolicy gzip removal: zero functional blast radius. The `noCachePolicy` is for `/index.html`; index.html is a few KB. Removing gzip on CloudFront's *cache key* layer doesn't disable response compression — that's controlled by the `compress: true` flag on the cache behaviour, which is independent.
- WAF SingleHeader Name fix: changes one rule's behavior from "always block (because the rule is malformed and AWS rejects the WAF entirely)" to "block when User-Agent header is missing or empty". Net positive — the rule now does what it claims.

## Rollback strategy

Rolling back the pre-deploy framework: delete the two new scripts and revert one block of `deploy-env.sh`. No state to clean up.

Rolling back the em-dash sweep: every change is text-substitution `—` -> `-`. Reverting the sweep restores the previous (deploy-broken) state. Don't.

Rolling back the CachePolicy gzip flag: re-add `enableAcceptEncodingGzip: true`. Will resume failing the deploy.

Rolling back the WAF SingleHeader Name fix: restore lowercase `name`. Will resume failing the deploy.

## Operator workflow after this lands

```
$ scripts/deploy-env.sh mwitt
  => Checking prereqs...
  => Installing infra dependencies...
  => Running pre-deploy validation...
     stage 1/4: cdk synth...                                  ok
     stage 2/4: cfn-lint cdk.out/OrbitalHub-mwitt.template.json...  ok
     stage 3/4: cycle-check (Tarjan SCC)...                   ok
     stage 4/4: cdk deploy --no-execute (AWS-side validation)... ok
     => pre-deploy validation passed (4/4 stages)
  => Computing CDK diff...
  ... (existing flow)
```

If a stage fails, operator sees actionable line/column info from cfn-lint (file path + JSON path) or actionable cycle from cycle-check (resource A -> B -> A), without burning a deploy.

## Confidence threshold rationale

Risk-High threshold = 95. Final confidence reported in the run summary.
