/**
 * replay-bucket.ts - Replay blob S3 bucket with SSE-KMS + lifecycle + Object Lock.
 *
 * [Engineer-Sr · Sonnet · run-round8-06-s3-cloudfront]
 *
 * Architecture:
 *   - Bucket name: orbital-replays-<env>-<account>
 *   - Public access fully blocked.
 *   - Encryption: SSE-KMS via a stack-level CMK (per-tenant CMK wired in 8-07).
 *   - Versioning: enabled (required for Object Lock + forensic recovery).
 *   - Object Lock: governance mode for prod (WORM - prevents deletion during retention window).
 *   - Lifecycle:
 *       Day 0-30:  STANDARD
 *       Day 30-90: STANDARD_IA (transition at day 30)
 *       Day 90+:   GLACIER_IR  (transition at day 90)
 *       Day 2555:  DELETE       (7 years = 2555 days)
 *   - Enforce SSL - no plain HTTP access.
 *   - KMS key: stack-level CMK with automatic rotation, used as the bucket default.
 *     8-07 (Secrets Manager + per-tenant CMK round) will supply per-tenant keys;
 *     the store-s3.ts driver already accepts a `kmsKeyArnFor` resolver.
 *
 * Coordinated with 8-02 Aurora agent via orbital-hub-stack.ts section markers.
 */

import * as cdk from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as kms from 'aws-cdk-lib/aws-kms'
import { Construct } from 'constructs'
import { NagSuppressions } from 'cdk-nag'

export interface ReplayBucketConstructProps {
  /** e.g. "mwitt" | "rreed" | "prod" */
  readonly envName: string
  /**
   * Retention in years for replay blobs.
   * Defaults to 7 (regulatory minimum for most compliance frameworks).
   */
  readonly retentionYears?: number
}

/** 7-year retention expressed in days. */
const SEVEN_YEARS_DAYS = 2555

/**
 * ReplayBucketConstruct provisions the S3 bucket that stores encrypted replay blobs.
 */
export class ReplayBucketConstruct extends Construct {
  /** The replay blob S3 bucket. */
  readonly bucket: s3.Bucket

  /**
   * Stack-level KMS CMK used for SSE-KMS encryption.
   * 8-07 will supply per-tenant keys via the S3Store kmsKeyArnFor resolver.
   */
  readonly encryptionKey: kms.Key

  constructor(scope: Construct, id: string, props: ReplayBucketConstructProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'
    const retentionDays = (props.retentionYears ?? 7) * 365

    // ------------------------------------------------------------------
    // KMS CMK - stack-level key (per-tenant keys added in 8-07)
    // ------------------------------------------------------------------
    this.encryptionKey = new kms.Key(this, 'EncryptionKey', {
      description: `Orbital replay blob encryption key - ${props.envName}`,
      alias: `orbital-replays-${props.envName}`,
      enableKeyRotation: true,
      // Non-prod can be torn down; prod key is retained for legal hold
      removalPolicy:
        isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    // ------------------------------------------------------------------
    // S3 Bucket
    // ------------------------------------------------------------------
    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `orbital-replays-${props.envName}-${cdk.Stack.of(this).account}`,

      // Block all public access - never publicly readable
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,

      // SSE-KMS with the stack-level CMK
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,

      // Versioning required for Object Lock
      versioned: true,

      // Enforce HTTPS only
      enforceSSL: true,

      // Object Lock: governance mode for prod (WORM)
      // objectLockEnabled + objectLockDefaultRetention can only be set at bucket
      // creation time via CloudFormation; CDK exposes this via the low-level
      // CfnBucket since the high-level Bucket does not yet have first-class support.
      // We add it via escape hatch below.

      // Non-prod: DESTROY; prod: RETAIN (legal hold obligation)
      removalPolicy:
        isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: !isProd,

      // Lifecycle rules: tiered storage + 7-year delete
      lifecycleRules: [
        {
          id: 'replay-blob-tiering',
          enabled: true,
          // Transition current + non-current versions to avoid storage accumulation
          transitions: [
            {
              // Day 30: STANDARD → STANDARD_IA
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
            {
              // Day 90: STANDARD_IA → GLACIER_IR (fast retrieval for audit investigations)
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(90),
            },
          ],
          // Delete versions older than 7 years
          expiration: cdk.Duration.days(retentionDays),
          // Also expire non-current versions to control costs
          noncurrentVersionExpiration: cdk.Duration.days(retentionDays),
          noncurrentVersionsToRetain: 3,
        },
      ],
    })

    // ------------------------------------------------------------------
    // Object Lock (prod only) - governance mode via CfnBucket escape hatch
    //
    // Object Lock must be enabled at bucket creation via CloudFormation.
    // CDK high-level Bucket does not expose ObjectLockEnabled directly, so
    // we use the L1 (CfnBucket) escape hatch. The governance-mode retention
    // default means S3 will refuse DELETE requests during the retention window
    // unless the caller has s3:BypassGovernanceRetention.
    // ------------------------------------------------------------------
    if (isProd) {
      const cfnBucket = this.bucket.node.defaultChild as s3.CfnBucket
      cfnBucket.objectLockEnabled = true
      cfnBucket.objectLockConfiguration = {
        objectLockEnabled: 'Enabled',
        rule: {
          defaultRetention: {
            mode: 'GOVERNANCE',
            years: props.retentionYears ?? 7,
          },
        },
      }
    }

    // ------------------------------------------------------------------
    // CloudFormation Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ReplayBucketName', {
      value: this.bucket.bucketName,
      description: `Orbital replay blob S3 bucket - ${props.envName}`,
      exportName: `OrbitalHub-${props.envName}-ReplayBucketName`,
    })

    new cdk.CfnOutput(this, 'ReplayKmsKeyArn', {
      value: this.encryptionKey.keyArn,
      description: `Orbital replay blob KMS key ARN - ${props.envName}`,
      exportName: `OrbitalHub-${props.envName}-ReplayKmsKeyArn`,
    })

    // ------------------------------------------------------------------
    // cdk-nag suppressions
    // ------------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(this.bucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'Server access logging for the replay bucket is omitted here. ' +
          'S3 access logging and CloudTrail data events are configured in the 8-08 observability round.',
      },
    ])
  }
}
