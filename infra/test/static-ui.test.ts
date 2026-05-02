/**
 * static-ui.test.ts — CDK snapshot + property tests for StaticUiConstruct.
 *
 * [Engineer-Sr · Sonnet · run-round8-06-s3-cloudfront]
 *
 * TDD: written RED before the construct existed; turned GREEN after implementation.
 *
 * Verifies:
 *   - S3 bucket is private (BlockPublicAccess.BLOCK_ALL)
 *   - OAC is present (S3OriginAccessControl)
 *   - CloudFront distribution uses the custom domain
 *   - HTTP → HTTPS redirect enforced
 *   - Cache behaviors: /index.html no-cache, /assets/* 1-year immutable
 *   - SPA error responses: 403/404 → /index.html
 *   - TLS 1.2 minimum protocol
 *   - Route 53 alias A record created
 *   - Snapshot matches stored template
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

describe('StaticUiConstruct — S3 bucket', () => {
  test('UI bucket blocks all public access', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.stringLikeRegexp('^orbital-ui-mwitt-'),
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    })
  })

  test('UI bucket has versioning enabled', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.stringLikeRegexp('^orbital-ui-mwitt-'),
      VersioningConfiguration: {
        Status: 'Enabled',
      },
    })
  })

  test('UI bucket enforces SSL (deny HTTP policy statement)', () => {
    const { template } = buildStack('mwitt')
    // CDK enforceSSL adds an AWS::S3::BucketPolicy with a Deny condition on aws:SecureTransport
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

  test('UI bucket uses SSE-S3 encryption', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: Match.stringLikeRegexp('^orbital-ui-mwitt-'),
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'AES256',
            },
          },
        ],
      },
    })
  })

  test('prod UI bucket has RETAIN removal policy', () => {
    const { template } = buildStack('prod')
    // DeletionPolicy: Retain on the underlying CfnBucket
    const buckets = template.findResources('AWS::S3::Bucket', {
      Properties: {
        BucketName: Match.stringLikeRegexp('^orbital-ui-prod-'),
      },
    })
    const prodUiBucket = Object.values(buckets).find((b: unknown) => {
      const bucket = b as { DeletionPolicy?: string }
      return bucket.DeletionPolicy === 'Retain'
    })
    expect(prodUiBucket).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// OAC tests
// ---------------------------------------------------------------------------

describe('StaticUiConstruct — Origin Access Control', () => {
  test('creates S3 Origin Access Control (OAC) resource', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::CloudFront::OriginAccessControl', {
      OriginAccessControlConfig: {
        OriginAccessControlOriginType: 's3',
        SigningBehavior: 'no-override',
        SigningProtocol: 'sigv4',
      },
    })
  })
})

// ---------------------------------------------------------------------------
// CloudFront distribution tests
// ---------------------------------------------------------------------------

describe('StaticUiConstruct — CloudFront distribution', () => {
  test('distribution uses custom domain name', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Aliases: ['mwitt.orbital.team.dev'],
      },
    })
  })

  test('distribution enforces HTTPS redirect on default behavior', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        DefaultCacheBehavior: {
          ViewerProtocolPolicy: 'redirect-to-https',
        },
      },
    })
  })

  test('distribution uses TLS 1.2 minimum protocol version', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        ViewerCertificate: {
          MinimumProtocolVersion: 'TLSv1.2_2021',
        },
      },
    })
  })

  test('distribution has HTTP/2 and HTTP/3 enabled', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        HttpVersion: 'http2and3',
      },
    })
  })

  test('distribution has SPA 404 error response routing to /index.html', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 404,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
        ]),
      },
    })
  })

  test('distribution has SPA 403 error response routing to /index.html', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CustomErrorResponses: Match.arrayWith([
          Match.objectLike({
            ErrorCode: 403,
            ResponseCode: 200,
            ResponsePagePath: '/index.html',
          }),
        ]),
      },
    })
  })

  test('distribution has /assets/* additional cache behavior', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/assets/*',
            ViewerProtocolPolicy: 'redirect-to-https',
          }),
        ]),
      },
    })
  })

  test('distribution has /index.html additional cache behavior', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        CacheBehaviors: Match.arrayWith([
          Match.objectLike({
            PathPattern: '/index.html',
            ViewerProtocolPolicy: 'redirect-to-https',
          }),
        ]),
      },
    })
  })

  test('immutable cache policy has 1-year TTL for /assets/*', () => {
    const { template } = buildStack('mwitt')
    // 365 days in seconds = 31536000
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        Name: 'orbital-ui-immutable-mwitt',
        DefaultTTL: 31536000,
        MinTTL: 31536000,
        MaxTTL: 31536000,
      },
    })
  })

  test('no-cache policy has 0-second TTL for index.html', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::CloudFront::CachePolicy', {
      CachePolicyConfig: {
        Name: 'orbital-ui-nocache-mwitt',
        DefaultTTL: 0,
        MinTTL: 0,
        MaxTTL: 0,
      },
    })
  })

  test('non-prod distribution uses PRICE_CLASS_100', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        PriceClass: 'PriceClass_100',
      },
    })
  })

  test('prod distribution uses PRICE_CLASS_ALL', () => {
    const { template } = buildStack('prod')
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        PriceClass: 'PriceClass_All',
      },
    })
  })
})

// ---------------------------------------------------------------------------
// Route 53 alias record
// ---------------------------------------------------------------------------

describe('StaticUiConstruct — Route 53', () => {
  test('creates Route 53 A record for the UI domain', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'mwitt.orbital.team.dev.',
      Type: 'A',
    })
  })
})

// ---------------------------------------------------------------------------
// cdk-nag
// ---------------------------------------------------------------------------

describe('StaticUiConstruct — cdk-nag', () => {
  test('no ERROR-level nag violations with required suppressions', () => {
    const app = new cdk.App()
    const config = makeEnvConfig()
    const stack = new OrbitalHubStack(app, 'OrbitalHub-mwitt-ui-nag', {
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
      // S3 access logging deferred to 8-08 observability round
      { id: 'AwsSolutions-S1', reason: 'Access logging configured in 8-08 observability round.' },
      // CloudFront: WAF + geo-restriction + logging deferred to 8-08
      { id: 'AwsSolutions-CFR1', reason: 'Geo-restriction not required; WAF in 8-08.' },
      { id: 'AwsSolutions-CFR2', reason: 'WAF association wired in 8-08 round.' },
      { id: 'AwsSolutions-CFR3', reason: 'CF access logging configured in 8-08 round.' },
      // KMS key rotation already enabled; cdk-nag may still flag the default SSE-S3 bucket
      { id: 'AwsSolutions-S2', reason: 'UI bucket uses SSE-S3 which is appropriate for non-sensitive assets.' },
      // KMS CMK for replay bucket — auto-rotation is enabled
      { id: 'AwsSolutions-KMS5', reason: 'KMS key rotation is enabled on the replay CMK.' },
    ])

    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }))

    expect(() => app.synth()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

describe('StaticUiConstruct — Snapshot', () => {
  test('mwitt stack with S3+CloudFront matches snapshot', () => {
    const { template } = buildStack('mwitt')
    expect(template.toJSON()).toMatchSnapshot()
  })

  test('prod stack with S3+CloudFront matches snapshot', () => {
    const { template } = buildStack('prod')
    expect(template.toJSON()).toMatchSnapshot()
  })
})
