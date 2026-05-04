/**
 * vault-bucket.ts — Obsidian vault sync S3 bucket.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 *
 * Architecture:
 *   - Bucket name: orbital-vault-<env>-<account>
 *   - Public access fully blocked.
 *   - Encryption: SSE-S3 (AES-256). v1 ships without a CMK to avoid an
 *     additional stateful resource decision; CMEK can be layered on later
 *     by switching to BucketEncryption.KMS + per-tenant keys (the same
 *     pattern the replay bucket uses).
 *   - Versioning: enabled — vault history is small + valuable.
 *   - Enforce SSL — no plain HTTP.
 *   - Lifecycle: vault objects are never auto-expired (humans + the plugin
 *     read them). Non-current versions expire after 90 days to bound cost.
 *   - CORS: GET/PUT from the web UI origin so signed-URL downloads work
 *     directly in the browser.
 *
 * Stateful-resource note: this construct creates a NEW persistent S3 bucket.
 * Per Engineer-Principal hard rule #1 the human approves before prod deploy.
 * The bucket uses RETAIN in prod to prevent accidental teardown.
 */

import * as cdk from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import { Construct } from 'constructs'
import { NagSuppressions } from 'cdk-nag'

export interface VaultBucketConstructProps {
  /** Environment name, e.g. "mwitt" | "rreed" | "prod". */
  readonly envName: string
  /**
   * Origins allowed to make signed-URL requests against the bucket.
   * Defaults to ['*'] for non-prod; production deployments should pass
   * the exact UI origin.
   */
  readonly allowedOrigins?: string[]
}

/**
 * VaultBucketConstruct provisions the S3 bucket holding the per-tenant
 * Obsidian vaults.
 */
export class VaultBucketConstruct extends Construct {
  /** The vault S3 bucket. */
  readonly bucket: s3.Bucket

  constructor(scope: Construct, id: string, props: VaultBucketConstructProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'

    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `orbital-vault-${props.envName}-${cdk.Stack.of(this).account}`,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      versioned: true,
      enforceSSL: true,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,
      lifecycleRules: [
        {
          id: 'vault-noncurrent-version-expiry',
          enabled: true,
          noncurrentVersionExpiration: cdk.Duration.days(90),
          noncurrentVersionsToRetain: 3,
        },
      ],
      cors: [
        {
          allowedMethods: [s3.HttpMethods.GET, s3.HttpMethods.PUT, s3.HttpMethods.HEAD],
          allowedOrigins: props.allowedOrigins ?? ['*'],
          allowedHeaders: ['*'],
          exposedHeaders: ['ETag'],
          maxAge: 3000,
        },
      ],
    })

    new cdk.CfnOutput(this, 'VaultBucketName', {
      value: this.bucket.bucketName,
      description: `Orbital Obsidian vault S3 bucket - ${props.envName}`,
      exportName: `OrbitalHub-${props.envName}-VaultBucketName`,
    })

    NagSuppressions.addResourceSuppressions(this.bucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'Server access logging is provided by CloudTrail data events at the account level. ' +
          'A per-bucket access log target is not required for the vault store.',
      },
      {
        id: 'AwsSolutions-S10',
        reason: 'enforceSSL=true already denies non-TLS requests via bucket policy.',
      },
    ])
  }
}
