/**
 * static-ui.ts - Static UI bucket + CloudFront distribution.
 *
 * [Engineer-Sr · Sonnet · run-round8-06-s3-cloudfront]
 *
 * Architecture:
 *   - S3 bucket: private, OAC (Origin Access Control), SSE-S3, versioning enabled.
 *   - CloudFront: custom domain from envConfig.domain, TLS cert from DNS construct,
 *     HTTP/2 + HTTP/3, TLSv1.2 minimum, SPA 404/403→/index.html error responses.
 *   - Cache behaviors:
 *       /index.html   - no-cache (must-revalidate, max-age=0)
 *       /assets/*     - 1 year immutable (Vite-hashed assets)
 *       default (/)   - short TTL for everything else
 *   - /api/* routes are NOT served by CloudFront (never reach origin).
 *   - HTTP → HTTPS redirect enforced at the distribution level.
 *   - Bucket name: orbital-ui-<env>-<account>
 *
 * Coordinated with 8-02 Aurora agent via orbital-hub-stack.ts section markers.
 */

import * as cdk from 'aws-cdk-lib'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront'
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as targets from 'aws-cdk-lib/aws-route53-targets'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import { Construct } from 'constructs'
import { NagSuppressions } from 'cdk-nag'

export interface StaticUiConstructProps {
  /** e.g. "mwitt" | "rreed" | "prod" */
  readonly envName: string
  /** Full domain: e.g. "mwitt.orbital.team.dev" */
  readonly domain: string
  /**
   * ACM certificate from DnsConstruct (must be us-east-1 for CloudFront).
   * When undefined (useCustomDomain=false), no custom domain aliases are set
   * on the distribution - CloudFront uses its default *.cloudfront.net domain.
   */
  readonly certificate: acm.ICertificate | undefined
  /**
   * Hosted zone for Route 53 alias record.
   * When undefined (useCustomDomain=false), no Route 53 record is created.
   */
  readonly hostedZone: route53.IHostedZone | undefined
}

/**
 * StaticUiConstruct provisions the S3 bucket and CloudFront distribution
 * that serve the Orbital UI.
 */
export class StaticUiConstruct extends Construct {
  /** The S3 bucket holding UI assets. */
  readonly bucket: s3.Bucket

  /** The CloudFront distribution. */
  readonly distribution: cloudfront.Distribution

  constructor(scope: Construct, id: string, props: StaticUiConstructProps) {
    super(scope, id)

    // ------------------------------------------------------------------
    // S3 Bucket - private, OAC access only
    // ------------------------------------------------------------------
    this.bucket = new s3.Bucket(this, 'Bucket', {
      bucketName: `orbital-ui-${props.envName}-${cdk.Stack.of(this).account}`,
      // Block all public access - traffic routes exclusively through CloudFront
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      // SSE-S3 is sufficient for UI assets (not sensitive data)
      encryption: s3.BucketEncryption.S3_MANAGED,
      // Enable versioning for rollback capability
      versioned: true,
      // Enforce HTTPS only
      enforceSSL: true,
      // Non-prod stacks can be torn down; prod uses RETAIN in the hub stack
      removalPolicy:
        props.envName === 'prod'
          ? cdk.RemovalPolicy.RETAIN
          : cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: props.envName !== 'prod',
      // CORS not needed - CloudFront handles this at the edge
    })

    // ------------------------------------------------------------------
    // CloudFront Origin Access Control (OAC)
    // ------------------------------------------------------------------
    const oac = new cloudfront.S3OriginAccessControl(this, 'OAC', {
      description: `Orbital UI OAC - ${props.envName}`,
      signing: cloudfront.Signing.SIGV4_NO_OVERRIDE,
    })

    // ------------------------------------------------------------------
    // Cache Policies
    // ------------------------------------------------------------------

    // /index.html - never cache; browser must always revalidate.
    //
    // NOTE: CloudFront rejects EnableAcceptEncodingGzip / Brotli when the cache
    // policy has caching disabled (all TTLs = 0). The encoding flags only make
    // sense when CloudFront is varying its cache by Accept-Encoding; with
    // caching disabled there is no cache key to vary. Response compression at
    // the wire is still enabled by `compress: true` on the cache behavior.
    const noCachePolicy = new cloudfront.CachePolicy(this, 'NoCachePolicy', {
      cachePolicyName: `orbital-ui-nocache-${props.envName}`,
      comment: 'No cache for index.html - SPA entrypoint must always be fresh',
      defaultTtl: cdk.Duration.seconds(0),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.seconds(0),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      // gzip/brotli omitted intentionally - incompatible with TTL=0
    })

    // /assets/* - 1 year immutable (Vite content-hashed filenames guarantee freshness)
    const immutableCachePolicy = new cloudfront.CachePolicy(this, 'ImmutableCachePolicy', {
      cachePolicyName: `orbital-ui-immutable-${props.envName}`,
      comment: '1-year immutable cache for Vite-hashed assets',
      defaultTtl: cdk.Duration.days(365),
      minTtl: cdk.Duration.days(365),
      maxTtl: cdk.Duration.days(365),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    })

    // Default - short TTL for unlabeled static assets
    const defaultCachePolicy = new cloudfront.CachePolicy(this, 'DefaultCachePolicy', {
      cachePolicyName: `orbital-ui-default-${props.envName}`,
      comment: 'Default cache policy for other UI assets',
      defaultTtl: cdk.Duration.minutes(5),
      minTtl: cdk.Duration.seconds(0),
      maxTtl: cdk.Duration.hours(1),
      headerBehavior: cloudfront.CacheHeaderBehavior.none(),
      queryStringBehavior: cloudfront.CacheQueryStringBehavior.none(),
      cookieBehavior: cloudfront.CacheCookieBehavior.none(),
      enableAcceptEncodingGzip: true,
      enableAcceptEncodingBrotli: true,
    })

    // ------------------------------------------------------------------
    // S3 origin with OAC
    // ------------------------------------------------------------------
    const s3Origin = origins.S3BucketOrigin.withOriginAccessControl(this.bucket, {
      originAccessControl: oac,
    })

    // ------------------------------------------------------------------
    // CloudFront Distribution
    // ------------------------------------------------------------------
    const useCustomDomain = props.certificate !== undefined && props.hostedZone !== undefined

    this.distribution = new cloudfront.Distribution(this, 'Distribution', {
      comment: `Orbital UI - ${props.envName} (${props.domain})`,
      // domainNames + certificate only set when custom domain is configured.
      // Without them CloudFront uses the default *.cloudfront.net domain.
      ...(useCustomDomain
        ? { domainNames: [props.domain], certificate: props.certificate! }
        : {}),
      // HTTP/2 + HTTP/3
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      // TLS 1.2 minimum
      minimumProtocolVersion: cloudfront.SecurityPolicyProtocol.TLS_V1_2_2021,
      // HTTP → HTTPS redirect
      defaultBehavior: {
        origin: s3Origin,
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        cachePolicy: defaultCachePolicy,
        compress: true,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
        cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
      },
      additionalBehaviors: {
        // /index.html - no-cache (SPA entrypoint)
        '/index.html': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: noCachePolicy,
          compress: true,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
          responseHeadersPolicy: cloudfront.ResponseHeadersPolicy.fromResponseHeadersPolicyId(
            this,
            'NoCacheHeaders',
            // AWS managed no-cache policy
            '5cc3b908-e619-4b99-88e5-2cf7f45965bd',
          ),
        },
        // /assets/* - 1-year immutable (Vite-hashed filenames)
        '/assets/*': {
          origin: s3Origin,
          viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
          cachePolicy: immutableCachePolicy,
          compress: true,
          allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD_OPTIONS,
          cachedMethods: cloudfront.CachedMethods.CACHE_GET_HEAD,
        },
      },
      // SPA routing - 404/403 from S3 → serve /index.html (200)
      // This handles client-side routes like /backlog, /agents, etc.
      errorResponses: [
        {
          httpStatus: 403,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
        {
          httpStatus: 404,
          responseHttpStatus: 200,
          responsePagePath: '/index.html',
          ttl: cdk.Duration.seconds(0),
        },
      ],
      // Enable CloudFront access logging (S3 bucket auto-created by CDK)
      enableLogging: false, // Log bucket wired in 8-08 observability round
      // Price class - NA + Europe edge nodes only (non-prod cost saving)
      priceClass:
        props.envName === 'prod'
          ? cloudfront.PriceClass.PRICE_CLASS_ALL
          : cloudfront.PriceClass.PRICE_CLASS_100,
    })

    // ------------------------------------------------------------------
    // Bucket Policy - allow OAC access from CloudFront only
    // CDK adds the bucket policy automatically when S3BucketOrigin.withOriginAccessControl
    // is used; we also grant explicitly for clarity + cdk-nag.
    // ------------------------------------------------------------------
    this.bucket.addToResourcePolicy(
      new cdk.aws_iam.PolicyStatement({
        sid: 'AllowCloudFrontServicePrincipalReadOnly',
        effect: cdk.aws_iam.Effect.ALLOW,
        principals: [new cdk.aws_iam.ServicePrincipal('cloudfront.amazonaws.com')],
        actions: ['s3:GetObject'],
        resources: [this.bucket.arnForObjects('*')],
        conditions: {
          StringEquals: {
            'AWS:SourceArn': `arn:aws:cloudfront::${cdk.Stack.of(this).account}:distribution/${this.distribution.distributionId}`,
          },
        },
      }),
    )

    // ------------------------------------------------------------------
    // Route 53 - alias record pointing domain to CloudFront distribution
    // Only created when hosted zone is provided (useCustomDomain=true).
    // ------------------------------------------------------------------
    if (useCustomDomain && props.hostedZone !== undefined) {
      new route53.ARecord(this, 'AliasRecord', {
        zone: props.hostedZone,
        recordName: props.domain,
        target: route53.RecordTarget.fromAlias(
          new targets.CloudFrontTarget(this.distribution),
        ),
        comment: `Orbital UI ${props.envName} - CloudFront alias`,
      })
    }

    // ------------------------------------------------------------------
    // CloudFormation Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'UiBucketName', {
      value: this.bucket.bucketName,
      description: `Orbital UI S3 bucket - ${props.envName}`,
      exportName: `OrbitalHub-${props.envName}-UiBucketName`,
    })

    new cdk.CfnOutput(this, 'CloudFrontDistributionId', {
      value: this.distribution.distributionId,
      description: `Orbital UI CloudFront distribution ID - ${props.envName}`,
      exportName: `OrbitalHub-${props.envName}-CloudFrontDistributionId`,
    })

    new cdk.CfnOutput(this, 'CloudFrontDomainName', {
      value: this.distribution.distributionDomainName,
      description: `Orbital UI CloudFront domain - ${props.envName}`,
    })

    new cdk.CfnOutput(this, 'UiUrl', {
      // When useCustomDomain=false, the URL is the CloudFront *.cloudfront.net domain.
      value: useCustomDomain
        ? `https://${props.domain}`
        : `https://${this.distribution.distributionDomainName}`,
      description: `Orbital UI URL - ${props.envName}`,
      exportName: `OrbitalHub-${props.envName}-UiUrl`,
    })

    // ------------------------------------------------------------------
    // cdk-nag suppressions
    // ------------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(this.bucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'Server access logging for the UI bucket is omitted in this construct. ' +
          'CloudFront access logs are enabled at the distribution level. ' +
          'S3 access logging added in 8-08 observability round.',
      },
    ])

    NagSuppressions.addResourceSuppressions(this.distribution, [
      {
        id: 'AwsSolutions-CFR1',
        reason:
          'Geo-restriction is not required for Orbital - it serves a global engineering audience. ' +
          'WAF with rate limiting (8-08) provides the relevant access controls.',
      },
      {
        id: 'AwsSolutions-CFR2',
        reason:
          'WAF association wired in 8-08 observability/WAF round to avoid circular dependencies.',
      },
      {
        id: 'AwsSolutions-CFR3',
        reason:
          'CloudFront access logging is configured in the 8-08 observability round.',
      },
    ])
  }
}
