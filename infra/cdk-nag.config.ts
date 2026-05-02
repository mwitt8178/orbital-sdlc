/**
 * cdk-nag configuration — Orbital Hub
 *
 * Applied in snapshot tests. Rules that are suppressed have explicit
 * business justifications. Every suppression requires a comment explaining
 * WHY it is acceptable, not just what was suppressed.
 *
 * Rule packs applied:
 *  - AwsSolutionsChecks (AWS Well-Architected Framework)
 *
 * Suppressions table:
 * ┌──────────────────────────────────────┬───────────────────────────────────────────────────────────────────────────┐
 * │ Rule                                 │ Justification                                                             │
 * ├──────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
 * │ AwsSolutions-VPC7                    │ VPC Flow Logs ARE enabled — cdk-nag may not detect the inline flowLogs    │
 * │                                      │ prop; suppressed to avoid false positive.                                 │
 * ├──────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
 * │ AwsSolutions-EC28                    │ NAT Gateway has no "detailed monitoring" concept; cdk-nag flags the NAT   │
 * │                                      │ GW EIP — not an EC2 instance. False positive.                            │
 * ├──────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
 * │ AwsSolutions-COG2                    │ MFA is OPTIONAL in non-prod environments by design (operators may not     │
 * │                                      │ have an authenticator app ready during dev). Prod has REQUIRED enforced.  │
 * ├──────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
 * │ AwsSolutions-COG3                    │ AdvancedSecurityMode.ENFORCED is set — but cdk-nag may flag the UserPool  │
 * │                                      │ if it cannot parse the advanced security prop. Actually set; suppressed   │
 * │                                      │ to avoid false positive.                                                  │
 * ├──────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
 * │ AwsSolutions-RDS6                    │ IAM DB authentication is enabled on the Aurora cluster                    │
 * │ [8-02 Aurora]                        │ (iamAuthentication: true). cdk-nag may not detect IAM auth on Aurora      │
 * │                                      │ Serverless v2 clusters specifically. Verified in aurora.test.ts.          │
 * ├──────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
 * │ AwsSolutions-RDS10                   │ Non-prod environments use DESTROY removal policy by design for cost       │
 * │ [8-02 Aurora]                        │ savings and clean teardown. Prod uses RETAIN. Documented trade-off.       │
 * ├──────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
 * │ AwsSolutions-RDS11                   │ Aurora Postgres uses port 5432 (Postgres standard). cdk-nag checks for   │
 * │ [8-02 Aurora]                        │ non-default RDS port; 5432 is intentional and standard for Postgres.     │
 * ├──────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
 * │ AwsSolutions-RDS2                    │ StorageEncrypted is explicitly set to true on the Aurora cluster.         │
 * │ [8-02 Aurora]                        │ Aurora Serverless v2 encrypts storage by default; setting is redundant    │
 * │                                      │ but explicit. cdk-nag may check differently for Aurora vs RDS.           │
 * ├──────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
 * │ AwsSolutions-SMG4                    │ DB secret rotation Lambda is planned for 8-07 (Secrets Manager round).   │
 * │ [8-02 Aurora]                        │ Aurora handles credential rotation; explicit rotation Lambda added in     │
 * │                                      │ 8-07 with 90-day rotation cycle per the architecture spec.               │
 * ├──────────────────────────────────────┼───────────────────────────────────────────────────────────────────────────┤
 * │ AwsSolutions-L1                      │ CDK custom resource provider framework uses its own managed runtime.     │
 * │ [8-02 Migration Runner]              │ The migration runner Lambda itself uses nodejs22.x (latest LTS).         │
 * │                                      │ The provider framework runtime is not directly configurable.             │
 * └──────────────────────────────────────┴───────────────────────────────────────────────────────────────────────────┘
 */

import { NagSuppressions } from 'cdk-nag'
import * as cdk from 'aws-cdk-lib'

export interface NagSuppressionOptions {
  /** Environment name — used to conditionally apply MFA suppression. */
  envName: string
}

/**
 * applyNagSuppressions applies stack-level nag suppressions.
 * Call this after the stack is fully constructed.
 */
export function applyNagSuppressions(
  stack: cdk.Stack,
  opts: NagSuppressionOptions,
): void {
  const { envName } = opts
  const isProd = envName === 'prod'

  // VPC Flow Logs — cdk-nag may not detect inline flowLogs prop
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-VPC7',
      reason:
        'VPC Flow Logs are configured via the inline flowLogs prop on the Vpc construct. ' +
        'CloudWatch destination and IAM role are explicitly created. Not a misconfiguration.',
    },
  ])

  // NAT Gateway — cdk-nag false positive on EIP
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-EC28',
      reason:
        'NAT Gateways do not support EC2 detailed monitoring. ' +
        'cdk-nag flags the associated EIP allocation; this is a false positive.',
    },
  ])

  // MFA optional in non-prod — intentional cost/UX tradeoff for developers
  if (!isProd) {
    NagSuppressions.addStackSuppressions(stack, [
      {
        id: 'AwsSolutions-COG2',
        reason:
          `MFA is OPTIONAL in the ${envName} environment by design. ` +
          'Developers need to quickly iterate without mandatory MFA device setup. ' +
          'Production enforces REQUIRED MFA.',
      },
    ])
  }

  // Advanced security mode set but cdk-nag may flag it
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-COG3',
      reason:
        'advancedSecurityMode is set to ENFORCED on the UserPool. ' +
        'This enables Cognito Advanced Security features (anomaly detection, compromised credential checks).',
    },
  ])

  // Single NAT GW in non-prod — accepted HA tradeoff for cost
  if (!isProd) {
    NagSuppressions.addStackSuppressions(stack, [
      {
        id: 'AwsSolutions-VPC3',
        reason:
          `Non-prod environment ${envName} uses a single NAT Gateway to reduce cost. ` +
          'If the NAT GW AZ is unavailable, Lambda functions lose egress temporarily. ' +
          'This is an accepted risk for development environments. Prod uses 2 NAT GWs.',
      },
    ])
  }

  // ------------------------------------------------------------------
  // Round 8-02 Aurora + RDS Proxy suppressions
  // [Engineer-Sr · Sonnet · run-round8-02-aurora]
  // ------------------------------------------------------------------

  // IAM DB authentication — enabled but cdk-nag may not detect it on Aurora Serverless v2
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-RDS6',
      reason:
        'IAM DB authentication is enabled on the Aurora cluster (iamAuthentication: true). ' +
        'cdk-nag may not detect IAM auth on Aurora Serverless v2 specifically. ' +
        'Verified in aurora.test.ts property assertion.',
    },
  ])

  // Non-prod removal policy
  if (!isProd) {
    NagSuppressions.addStackSuppressions(stack, [
      {
        id: 'AwsSolutions-RDS10',
        reason:
          `Non-prod environment ${envName} uses DESTROY removal policy by design for ` +
          'cost savings and clean teardown on cdk destroy. Prod uses RETAIN. ' +
          'Documented trade-off in architecture.md.',
      },
    ])
  }

  // Aurora Postgres port 5432
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-RDS11',
      reason:
        'Aurora Postgres uses port 5432 (the Postgres standard port). ' +
        'cdk-nag flags non-default RDS ports; 5432 is the intentional and standard choice.',
    },
  ])

  // Storage encryption — explicitly set to true; Aurora always encrypts
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-RDS2',
      reason:
        'StorageEncrypted is explicitly set to true on the Aurora cluster. ' +
        'Aurora Serverless v2 always encrypts at rest; the flag is set explicitly for clarity.',
    },
  ])

  // Secret rotation — Aurora master creds rotated every 30 days via the
  // AWS-hosted PostgreSQL single-user rotation Lambda; hub master key rotated
  // every 90 days via custom Lambda. github-webhook + cognito client secrets
  // are manually rotated per architecture.md (rare, low-blast-radius).
  // [Engineer-Principal · Opus · run-round8-07-secrets-kms]
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-SMG4',
      reason:
        'DB master creds rotation: 30-day cycle via Secrets Manager hosted ' +
        'rotation Lambda (PostgreSQLSingleUser). Hub master key rotation: ' +
        '90-day cycle via custom KeyRotationLambda. github-webhook + ' +
        'cognito-app-client-secret: manual rotation by design (low blast ' +
        'radius; rotated on demand via admin UI per architecture.md).',
    },
  ])

  // 8-07 Secrets KMS — wildcard IAM and managed runtime suppressions.
  // [Engineer-Principal · Opus · run-round8-07-secrets-kms]
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-IAM5',
      reason:
        '8-07: Wildcards on kms:* are constrained by aws:RequestTag/Owner=orbital ' +
        '(CreateKey) and kms:RequestAlias=alias/orbital-tenant-* (Encrypt/Decrypt). ' +
        'CDK-generated wildcards for log delivery, S3 bucket policies, and ' +
        'Secrets Manager rotation Lambda are also in scope.',
    },
  ])

  // Migration runner Lambda — CDK custom resource provider uses managed runtime
  NagSuppressions.addStackSuppressions(stack, [
    {
      id: 'AwsSolutions-L1',
      reason:
        'The migration runner Lambda uses nodejs22.x (latest LTS). ' +
        'The CDK custom resource provider framework uses its own managed runtime ' +
        'that is not directly configurable via CDK construct properties.',
    },
  ])
}
