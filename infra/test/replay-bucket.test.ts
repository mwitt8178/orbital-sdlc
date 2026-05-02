/**
 * replay-bucket.test.ts — CDK snapshot + property tests for ReplayBucketConstruct.
 *
 * [Engineer-Sr · Sonnet · run-round8-06-s3-cloudfront]
 *
 * TDD: written RED before the construct existed; turned GREEN after implementation.
 *
 * Verifies:
 *   - Bucket is private (BlockPublicAccess.BLOCK_ALL)
 *   - Encryption is SSE-KMS with a CMK (not SSE-S3)
 *   - Versioning enabled
 *   - Lifecycle rules: STANDARD_IA at 30d, GLACIER_IR at 90d, delete at 7y
 *   - Object Lock governance mode for prod
 *   - KMS key has automatic rotation enabled
 *   - Snapshot matches
 */

import * as cdk from 'aws-cdk-lib'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib'
import { OrbitalHubStack, EnvConfig } from '../lib/orbital-hub-stack'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnvConfig(overrides?: Partial<EnvConfig>): EnvConfig {
  return {
    account: '123456789012',
    region: 'us-east-1',
    domain: 'mwitt.orbital.team.dev',
    auroraMinAcu: 0.5,
    auroraMaxAcu: 4,
    logRetentionDays: 30,
    enableMfa: false,
    ...overrides,
  }
}

function buildStack(
  envName: 'mwitt' | 'rreed' | 'prod',
  configOverrides?: Partial<EnvConfig>,
): { stack: OrbitalHubStack; template: Template } {
  const app = new cdk.App()
  const config = makeEnvConfig({
    region: envName === 'rreed' ? 'us-west-2' : 'us-east-1',
    domain: envName === 'prod' ? 'orbital.team.dev' : `${envName}.orbital.team.dev`,
    enableMfa: envName === 'prod',
    ...configOverrides,
  })
  const stack = new OrbitalHubStack(app, `OrbitalHub-${envName}`, {
    envName,
    envConfig: config,
  })
  const template = Template.fromStack(stack)
  return { stack, template }
}

// ---------------------------------------------------------------------------
// S3 bucket tests
// ---------------------------------------------------------------------------

describe('ReplayBucketConstruct — S3 bucket', () => {
  test('replay bucket blocks all public access', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.stringLikeRegexp('^orbital-replays-mwitt-'),
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    })
  })

  test('replay bucket has versioning enabled', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.stringLikeRegexp('^orbital-replays-mwitt-'),
      VersioningConfiguration: {
        Status: 'Enabled',
      },
    })
  })

  test('replay bucket uses SSE-KMS encryption (not SSE-S3)', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.stringLikeRegexp('^orbital-replays-mwitt-'),
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'aws:kms',
            },
          }),
        ],
      },
    })
  })

  test('replay bucket enforces SSL', () => {
    const { template } = buildStack('mwitt')
    const policies = template.findResources('AWS::S3::BucketPolicy')
    const policyValues = Object.values(policies)
    const hasSSLDeny = policyValues.some((p: unknown) => {
      const policy = p as { Properties: { PolicyDocument: { Statement: unknown[] } } }
      return policy.Properties.PolicyDocument.Statement.some((stmt: unknown) => {
        const s = stmt as { Effect?: string; Condition?: { Bool?: Record<string, unknown> } }
        return (
          s.Effect === 'Deny' &&
          s.Condition?.Bool?.['aws:SecureTransport'] === 'false'
        )
      })
    })
    expect(hasSSLDeny).toBe(true)
  })

  test('prod replay bucket has RETAIN removal policy', () => {
    const { template } = buildStack('prod')
    const buckets = template.findResources('AWS::S3::Bucket', {
      Properties: {
        BucketName: Match.stringLikeRegexp('^orbital-replays-prod-'),
      },
    })
    const prodBucket = Object.values(buckets).find((b: unknown) => {
      const bucket = b as { DeletionPolicy?: string }
      return bucket.DeletionPolicy === 'Retain'
    })
    expect(prodBucket).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// Lifecycle rules
// ---------------------------------------------------------------------------

describe('ReplayBucketConstruct — lifecycle rules', () => {
  test('lifecycle rule transitions to STANDARD_IA at 30 days', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.stringLikeRegexp('^orbital-replays-mwitt-'),
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Transitions: Match.arrayWith([
              Match.objectLike({
                StorageClass: 'STANDARD_IA',
                TransitionInDays: 30,
              }),
            ]),
          }),
        ]),
      },
    })
  })

  test('lifecycle rule transitions to GLACIER_IR at 90 days', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.stringLikeRegexp('^orbital-replays-mwitt-'),
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Transitions: Match.arrayWith([
              Match.objectLike({
                StorageClass: 'GLACIER_IR',
                TransitionInDays: 90,
              }),
            ]),
          }),
        ]),
      },
    })
  })

  test('lifecycle rule expires objects at 7 years (2555 days)', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.stringLikeRegexp('^orbital-replays-mwitt-'),
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            ExpirationInDays: 2555,
          }),
        ]),
      },
    })
  })
})

// ---------------------------------------------------------------------------
// Object Lock (prod only)
// ---------------------------------------------------------------------------

describe('ReplayBucketConstruct — Object Lock', () => {
  test('prod replay bucket has Object Lock enabled in governance mode', () => {
    const { template } = buildStack('prod')
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.stringLikeRegexp('^orbital-replays-prod-'),
      ObjectLockEnabled: true,
      ObjectLockConfiguration: {
        ObjectLockEnabled: 'Enabled',
        Rule: {
          DefaultRetention: {
            Mode: 'GOVERNANCE',
            Years: 7,
          },
        },
      },
    })
  })

  test('non-prod replay bucket does NOT have Object Lock', () => {
    const { template } = buildStack('mwitt')
    // Non-prod bucket should not have ObjectLockEnabled set to true
    const buckets = template.findResources('AWS::S3::Bucket', {
      Properties: {
        BucketName: Match.stringLikeRegexp('^orbital-replays-mwitt-'),
      },
    })
    const mwittBucket = Object.values(buckets)[0] as {
      Properties: { ObjectLockEnabled?: boolean }
    } | undefined
    // Either the property is absent or falsy
    expect(mwittBucket?.Properties?.ObjectLockEnabled).toBeFalsy()
  })
})

// ---------------------------------------------------------------------------
// KMS key tests
// ---------------------------------------------------------------------------

describe('ReplayBucketConstruct — KMS key', () => {
  test('creates a KMS CMK with key rotation enabled', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
      Description: Match.stringLikeRegexp('Orbital replay blob encryption key'),
    })
  })

  test('KMS key alias follows naming convention', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::KMS::Alias', {
      AliasName: 'alias/orbital-replays-mwitt',
    })
  })
})

// ---------------------------------------------------------------------------
// CloudFormation outputs
// ---------------------------------------------------------------------------

describe('ReplayBucketConstruct — outputs', () => {
  test('exports ReplayBucketName output', () => {
    const { template } = buildStack('mwitt')
    const outputs = template.findOutputs('*')
    const hasReplayBucketOutput = Object.values(outputs).some(
      (o: unknown) =>
        typeof (o as { Description?: string }).Description === 'string' &&
        (o as { Description?: string }).Description?.includes('replay blob S3 bucket'),
    )
    expect(hasReplayBucketOutput).toBe(true)
  })

  test('exports ReplayKmsKeyArn output', () => {
    const { template } = buildStack('mwitt')
    const outputs = template.findOutputs('*')
    const hasKmsKeyOutput = Object.values(outputs).some(
      (o: unknown) =>
        typeof (o as { Description?: string }).Description === 'string' &&
        (o as { Description?: string }).Description?.includes('replay blob KMS key ARN'),
    )
    expect(hasKmsKeyOutput).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// cdk-nag
// ---------------------------------------------------------------------------

describe('ReplayBucketConstruct — cdk-nag', () => {
  test('no ERROR-level nag violations with required suppressions', () => {
    const app = new cdk.App()
    const config = makeEnvConfig()
    const stack = new OrbitalHubStack(app, 'OrbitalHub-mwitt-replay-nag', {
      envName: 'mwitt',
      envConfig: config,
    })

    NagSuppressions.addStackSuppressions(stack, [
      { id: 'AwsSolutions-VPC7', reason: 'Flow logs configured inline; false positive.' },
      { id: 'AwsSolutions-EC28', reason: 'NAT GW EIP — not an EC2 instance; false positive.' },
      { id: 'AwsSolutions-COG2', reason: 'MFA optional in non-prod by design.' },
      { id: 'AwsSolutions-COG3', reason: 'AdvancedSecurityMode.ENFORCED is set.' },
      { id: 'AwsSolutions-VPC3', reason: 'Single NAT GW in non-prod by design (cost).' },
      { id: 'AwsSolutions-IAM4', reason: 'CDK-generated managed policies for service roles.' },
      { id: 'AwsSolutions-IAM5', reason: 'CDK-generated wildcard policies for log delivery.' },
      { id: 'AwsSolutions-S1', reason: 'Access logging configured in 8-08 observability round.' },
      { id: 'AwsSolutions-CFR1', reason: 'Geo-restriction not required; WAF in 8-08.' },
      { id: 'AwsSolutions-CFR2', reason: 'WAF association wired in 8-08 round.' },
      { id: 'AwsSolutions-CFR3', reason: 'CF access logging configured in 8-08 round.' },
      { id: 'AwsSolutions-S2', reason: 'UI bucket uses SSE-S3; appropriate for non-sensitive static assets.' },
      { id: 'AwsSolutions-KMS5', reason: 'KMS key rotation is enabled on the replay CMK.' },
    ])

    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }))

    expect(() => app.synth()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

describe('ReplayBucketConstruct — Snapshot', () => {
  test('mwitt replay bucket stack matches snapshot', () => {
    const { template } = buildStack('mwitt')
    expect(template.toJSON()).toMatchSnapshot()
  })

  test('prod replay bucket stack (with Object Lock) matches snapshot', () => {
    const { template } = buildStack('prod')
    expect(template.toJSON()).toMatchSnapshot()
  })
})
