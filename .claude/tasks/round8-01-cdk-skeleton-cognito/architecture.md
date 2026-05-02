# Round 8-01 — CDK Skeleton + VPC + Cognito + DNS

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: L

## Why
First Round 8 task. Stand up the IaC scaffold so subsequent tasks have a single stack to attach into. Cognito set up here so 8-03's Lambda authorizer can validate JWTs.

## Reference
See `/Users/matthewwitt/AI SDLC/orbital/.claude/tasks/round8-aws-migration/architecture.md` for the full Round 8 design.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| NEW `infra/` (or `cdk/`) directory | `infra/{cdk.json,bin/orbital.ts,lib/orbital-hub-stack.ts,lib/constructs/{vpc.ts,cognito.ts,dns.ts}}` | CDK app |
| `infra/test/snapshot.test.ts` | NEW | Snapshot + property tests of synthesized templates |
| Root `package.json` | extend | Add `infra` workspace; `cdk` script |
| Root `tsconfig.base.json` | extend | infra path |
| `docs/aws-deployment.md` | NEW (start) | First sections: prerequisites, env setup, deploy command |

## CDK app structure
```
infra/
├── cdk.json                      # context: per-env config
├── bin/
│   └── orbital.ts                # CDK app entrypoint
├── lib/
│   ├── orbital-hub-stack.ts      # the SINGLE stack (extended in later sub-tasks)
│   └── constructs/
│       ├── vpc.ts                # VPC + subnets + NAT
│       ├── cognito.ts            # User pool + app client + identity pool
│       └── dns.ts                # Route 53 + ACM
├── test/
│   └── snapshot.test.ts          # cdk-nag + snapshot
└── package.json
```

## cdk.json env context
```json
{
  "app": "npx ts-node bin/orbital.ts",
  "context": {
    "envs": {
      "mwitt": {
        "account": "<TBD>",
        "region": "us-east-1",
        "domain": "mwitt.orbital.team.dev",
        "auroraMinAcu": 0.5,
        "auroraMaxAcu": 4,
        "logRetentionDays": 30,
        "enableMfa": false
      },
      "rreed": {
        "account": "<TBD>",
        "region": "us-west-2",
        "domain": "rreed.orbital.team.dev",
        "auroraMinAcu": 0.5,
        "auroraMaxAcu": 4,
        "logRetentionDays": 30,
        "enableMfa": false
      },
      "prod": {
        "account": "<TBD>",
        "region": "us-east-1",
        "domain": "orbital.team.dev",
        "auroraMinAcu": 1,
        "auroraMaxAcu": 16,
        "logRetentionDays": 90,
        "enableMfa": true
      }
    }
  }
}
```

Account IDs left as `<TBD>` — operator fills in via env var or CLI prompt before first deploy. Don't commit real account IDs to repo.

## Stack: `OrbitalHubStack`
```typescript
export interface OrbitalHubStackProps extends StackProps {
  envName: 'mwitt' | 'rreed' | 'prod'
  envConfig: EnvConfig
}

export class OrbitalHubStack extends Stack {
  // Subsequent sub-tasks attach: aurora, lambda, apigw, ws, sns/sqs, s3, secrets, observability
  // 8-01 puts in: vpc, cognito, dns

  readonly vpc: Vpc
  readonly cognito: CognitoConstruct
  readonly dns: DnsConstruct
  readonly hostedZone: IHostedZone
  readonly cert: ICertificate

  constructor(scope: Construct, id: string, props: OrbitalHubStackProps) {
    super(scope, id, props)
    this.vpc = new VpcConstruct(this, 'Vpc', { /* ... */ }).vpc
    this.dns = new DnsConstruct(this, 'Dns', { domain: props.envConfig.domain })
    this.cognito = new CognitoConstruct(this, 'Cognito', {
      envName: props.envName,
      enableMfa: props.envConfig.enableMfa,
    })
  }
}
```

## VPC construct
- 2 AZ
- Public subnets (for NAT GW, future ALB if needed)
- Private subnets with egress (for Lambda)
- Isolated subnets (for Aurora — no internet)
- Single NAT GW for non-prod, 2 NAT GWs for prod
- Flow Logs to CloudWatch (90-day retention)
- VPC endpoints for S3, Secrets Manager, KMS (avoid NAT charges)

## Cognito construct
**User pool:**
- Name: `orbital-${envName}`
- Username: email
- Required attributes: email, given_name, family_name
- Password policy: 12+ chars, mixed case, number, symbol
- MFA: optional in dev/staging, required in prod
- Account recovery: email-only (NOT SMS — social engineering risk)
- Lambda triggers: `pre-sign-up` validates email domain (configurable per tenant), `post-confirmation` writes user record

**App client:**
- SPA-friendly: OAuth code flow with PKCE
- Callback URLs: `https://<domain>/auth/callback`
- Sign-out URLs: `https://<domain>/auth/signed-out`
- Token validity: id_token 1h, access_token 1h, refresh_token 30d
- Allowed scopes: `openid email profile orbital/api`

**Identity pool:**
- Optional — only if we want temporary AWS creds for browsers (probably not for v1)

**Hosted UI:**
- `auth.${domain}` subdomain
- Custom branding (logo, primary color)
- Google + Microsoft OAuth (configurable per env via context)

## DNS construct
- If hosted zone for `${domain}` already exists in account → use it
- Else create new hosted zone (operator must update parent zone NS records manually — surface this in deploy output)
- ACM cert for `*.${domain}` validated via DNS
- Output: zone ID, cert ARN

## Bootstrap requirement
Each AWS account/region needs `cdk bootstrap` once before first deploy. Document in `docs/aws-deployment.md`.

## cdk-nag
Add `cdk-nag` checks to the snapshot test. Failed checks fail the build. Suppression list (with justification) for any unavoidable warnings (e.g., NAT GW in single-AZ for non-prod).

## Frontend UX
None for 8-01. UI integration with Cognito comes in 8-03 (when API auth lands).

## Acceptance criteria
1. `cd infra && npm install && npm run synth -- --context env=mwitt` produces valid CloudFormation.
2. `cdk diff --context env=mwitt` against an empty account shows: VPC + Cognito + Route 53 + ACM resources.
3. `cdk deploy --context env=mwitt --require-approval never` succeeds (dry run on a sandbox account; do NOT auto-deploy until operator approves).
4. After deploy, `aws cognito-idp list-user-pools --max-results 5` shows `orbital-mwitt` user pool in `us-east-1`.
5. ACM cert validates DNS record correctly.
6. Snapshot test passes on `npm test`.
7. cdk-nag passes (or suppressions are documented).
8. `docs/aws-deployment.md` walks an engineer from zero to deployed mwitt env in <30 min.

## Hard-stop checks
```
ls infra/cdk.json infra/bin/orbital.ts infra/lib/orbital-hub-stack.ts
grep -E "OrbitalHubStack" infra/lib/orbital-hub-stack.ts
grep -E "CognitoConstruct|UserPool" infra/lib/constructs/cognito.ts
cd infra && npm run synth -- --context env=mwitt 2>&1 | tail -5
```

## Operator approval gates
**Before first cdk deploy:** This task's acceptance criteria #3 is a deploy. The agent must NOT run `cdk deploy` without explicit operator approval (env var or interactive prompt). The agent CAN run `cdk synth` and `cdk diff` freely. Update progress.md with the cdk diff output for operator review.

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round8-01-cdk-skeleton-cognito]`
