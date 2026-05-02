// [Engineer-Principal · Opus · run-round8-07-secrets-kms]
/**
 * per-tenant-kms.ts — IAM permissions for runtime per-tenant CMK provisioning.
 *
 * IMPORTANT: This construct does NOT create any CMKs at deploy time. Per-tenant
 * keys are provisioned ON DEMAND when a new tenant signs up, by the orchestrator
 * runtime code in `packages/orchestrator/src/onboarding/tenant-kms.ts`.
 *
 * What this construct DOES:
 *   1. Defines the IAM grant `grantOnboardingPermissions(...)` that gives a
 *      specific Lambda role the `kms:CreateKey`, `kms:CreateAlias`, and
 *      `kms:TagResource` permissions, scoped to the `alias/orbital-tenant-*`
 *      namespace. ONLY the onboarding Lambda receives this grant.
 *
 *   2. Defines `grantPerTenantUsage(...)` which gives a Lambda role the
 *      ability to call `kms:Encrypt`, `kms:Decrypt`, and `kms:GenerateDataKey`
 *      against any key whose alias matches `alias/orbital-tenant-*`. The
 *      condition is `kms:RequestAlias` so a Lambda holding this permission
 *      cannot decrypt KMS keys outside the orbital-tenant- namespace.
 *
 *   3. Defines `grantTenantDeletion(...)` which gives a privileged Lambda
 *      (admin/onboarding cleanup) the ability to schedule key deletion +
 *      delete the alias. Used during tenant offboarding (right-to-erasure).
 *
 * Cross-tenant isolation:
 *   The `kms:RequestAlias` condition on `grantPerTenantUsage` does not by
 *   itself prevent tenant A's Lambda from decrypting tenant B's blob. Cross-
 *   tenant isolation is enforced by the application layer in
 *   `tenant-kms.ts`: the resolver looks up the tenant's CMK ARN from the
 *   `tenants` row keyed by tenant_id, then passes that ARN to S3
 *   `SSEKMSKeyId`. A Lambda processing tenant A's request can never receive
 *   tenant B's CMK ARN unless the database itself is compromised.
 *
 *   Defense in depth: each per-tenant CMK is created with a key policy that
 *   grants Encrypt/Decrypt only to the tenant's IAM principals AND the hub
 *   role (audited per call via CloudTrail).
 */

import * as cdk from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import { Construct } from 'constructs'

export interface PerTenantKmsConstructProps {
  /** e.g. "mwitt" | "rreed" | "prod" */
  readonly envName: string
  /** AWS account id where keys live. */
  readonly account: string
  /** AWS region where keys live. */
  readonly region: string
}

/**
 * The alias prefix used for every per-tenant CMK.
 * Aliases must start with `alias/`; we constrain to `alias/orbital-tenant-`.
 */
export const TENANT_KEY_ALIAS_PREFIX = 'alias/orbital-tenant-'

/**
 * PerTenantKmsConstruct — IAM-only construct for runtime per-tenant key mgmt.
 */
export class PerTenantKmsConstruct extends Construct {
  readonly envName: string
  readonly account: string
  readonly region: string

  constructor(scope: Construct, id: string, props: PerTenantKmsConstructProps) {
    super(scope, id)
    this.envName = props.envName
    this.account = props.account
    this.region = props.region

    // CfnOutput so operators can verify the grant patterns are wired without
    // chasing them through IAM policies.
    new cdk.CfnOutput(this, 'TenantKeyAliasPrefix', {
      value: TENANT_KEY_ALIAS_PREFIX,
      description: `Per-tenant CMK alias prefix — ${props.envName}`,
      exportName: `OrbitalHub-${props.envName}-TenantKeyAliasPrefix`,
    })

    cdk.Tags.of(this).add('orbital:component', 'per-tenant-kms')
  }

  /**
   * Grant a Lambda role permission to provision new per-tenant CMKs at
   * runtime. ONLY the onboarding Lambda should receive this grant.
   *
   * Permissions added:
   *   - kms:CreateKey                            (resource = *; constrained by IAM tag conditions)
   *   - kms:CreateAlias                          (alias resource = alias/orbital-tenant-*)
   *   - kms:TagResource                          (so we can tag the new key with tenantId)
   *   - kms:DescribeKey                          (read after create to capture ARN)
   *   - kms:PutKeyPolicy                         (apply per-tenant key policy)
   *   - kms:EnableKeyRotation                    (enable rotation on the new key)
   *
   * The CreateKey action must be wildcard-resourced because the key does
   * not exist yet at the time of the API call. We tighten via the
   * `kms:RequestTag/Owner` condition: only requests that tag the new key
   * with `Owner=orbital` are allowed. The IAM policy below enforces this.
   */
  grantOnboardingPermissions(grantee: iam.IGrantable): void {
    const principal = grantee.grantPrincipal
    if (!principal) {
      throw new Error('grantOnboardingPermissions: grantee has no grantPrincipal')
    }

    iam.Grant.addToPrincipal({
      grantee,
      actions: [
        'kms:CreateKey',
        'kms:TagResource',
        'kms:EnableKeyRotation',
        'kms:PutKeyPolicy',
      ],
      // CreateKey + TagResource both require resource = "*" because the key does
      // not exist before the call returns. Constrain by the kms:RequestTag
      // condition: only requests that tag the new key with Owner=orbital may run.
      resourceArns: ['*'],
      conditions: {
        StringEquals: {
          'aws:RequestTag/Owner': 'orbital',
          'aws:RequestTag/Env': this.envName,
        },
      },
    })

    // CreateAlias is scoped to the alias/orbital-tenant-* namespace.
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['kms:CreateAlias'],
      resourceArns: [
        // Alias arn pattern: arn:aws:kms:<region>:<account>:alias/orbital-tenant-*
        `arn:aws:kms:${this.region}:${this.account}:${TENANT_KEY_ALIAS_PREFIX}*`,
        // The alias also targets a key — wildcard resource because key id is not
        // known at policy eval; the alias arn constraint above provides the
        // namespace boundary.
        `arn:aws:kms:${this.region}:${this.account}:key/*`,
      ],
    })

    // DescribeKey is used to capture the new key's ARN after create.
    iam.Grant.addToPrincipal({
      grantee,
      actions: ['kms:DescribeKey'],
      resourceArns: [`arn:aws:kms:${this.region}:${this.account}:key/*`],
    })
  }

  /**
   * Grant a Lambda role permission to USE per-tenant CMKs (Encrypt, Decrypt,
   * GenerateDataKey).
   *
   * The grant is scoped via `kms:RequestAlias`: every API call must reference
   * a key by its `alias/orbital-tenant-*` alias. A Lambda holding this grant
   * cannot operate on:
   *   - The hub-secrets CMK (alias/orbital-${env}-hub-secrets)
   *   - The replay CMK (alias/orbital-replays-${env})
   *   - Any other CMK in the account.
   *
   * Note on cross-tenant: this grant alone is NOT cross-tenant safe — a
   * compromised Lambda processing tenant A could in theory pass a different
   * tenant's alias if it could discover one. Defense in depth is enforced
   * by the application layer in tenant-kms.ts which only ever resolves the
   * alias from the authenticated tenant's row in the database.
   */
  grantPerTenantUsage(grantee: iam.IGrantable): void {
    iam.Grant.addToPrincipal({
      grantee,
      actions: [
        'kms:Encrypt',
        'kms:Decrypt',
        'kms:GenerateDataKey',
        'kms:GenerateDataKeyWithoutPlaintext',
        'kms:DescribeKey',
        'kms:ReEncryptFrom',
        'kms:ReEncryptTo',
      ],
      resourceArns: [`arn:aws:kms:${this.region}:${this.account}:key/*`],
      conditions: {
        StringLike: {
          'kms:RequestAlias': `${TENANT_KEY_ALIAS_PREFIX}*`,
        },
      },
    })
  }

  /**
   * Grant a Lambda role permission to delete per-tenant CMKs (alias delete +
   * key schedule deletion). Used by the tenant offboarding flow to honour
   * right-to-erasure: replay blobs become unreadable when the CMK is
   * scheduled for deletion (30-day waiting period mandatory).
   */
  grantTenantDeletion(grantee: iam.IGrantable): void {
    iam.Grant.addToPrincipal({
      grantee,
      actions: [
        'kms:DeleteAlias',
        'kms:ScheduleKeyDeletion',
        'kms:DescribeKey',
      ],
      resourceArns: [
        `arn:aws:kms:${this.region}:${this.account}:${TENANT_KEY_ALIAS_PREFIX}*`,
        `arn:aws:kms:${this.region}:${this.account}:key/*`,
      ],
      conditions: {
        StringLike: {
          'kms:ResourceAliases': `${TENANT_KEY_ALIAS_PREFIX}*`,
        },
      },
    })
  }
}
