// [Engineer-Sr · Sonnet · run-round8-10-no-dns-mwitt]
/**
 * no-dns-mwitt.test.ts — Verifies that the mwitt env synthesizes with zero
 * Route 53 and zero ACM resources, and that prod/rreed retain them.
 *
 * AC:
 *   1. mwitt (useCustomDomain=false): 0 AWS::Route53::* resources
 *   2. mwitt (useCustomDomain=false): 0 AWS::CertificateManager::* resources
 *   3. mwitt CloudFront has no custom domain Aliases
 *   4. mwitt Cognito uses prefix domain (orbital-mwitt.auth...)
 *   5. prod (useCustomDomain=true): >= 1 Route53 HostedZone
 *   6. prod (useCustomDomain=true): >= 1 ACM Certificate
 *   7. rreed (useCustomDomain=true): >= 1 Route53 HostedZone
 *   8. rreed (useCustomDomain=true): >= 1 ACM Certificate
 *   9. Backwards compat: omitting useCustomDomain defaults to true (creates DNS)
 */

import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { OrbitalHubStack, EnvConfig } from '../lib/orbital-hub-stack'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildStack(
  envName: 'mwitt' | 'rreed' | 'prod',
  useCustomDomain: boolean,
): Template {
  const app = new cdk.App()
  const domain = envName === 'prod' ? 'orbital.team.dev' : `${envName}.orbital.team.dev`
  const config: EnvConfig = {
    account: '123456789012',
    region: envName === 'rreed' ? 'us-west-2' : 'us-east-1',
    domain,
    auroraMinAcu: 0.5,
    auroraMaxAcu: 4,
    logRetentionDays: 30,
    enableMfa: envName === 'prod',
    useCustomDomain,
  }
  const stack = new OrbitalHubStack(app, `OrbitalHub-${envName}`, {
    envName,
    envConfig: config,
  })
  return Template.fromStack(stack)
}

function buildStackOmitFlag(envName: 'mwitt' | 'rreed' | 'prod'): Template {
  // Omits useCustomDomain to verify backwards-compat default=true
  const app = new cdk.App()
  const domain = envName === 'prod' ? 'orbital.team.dev' : `${envName}.orbital.team.dev`
  const config: EnvConfig = {
    account: '123456789012',
    region: 'us-east-1',
    domain,
    auroraMinAcu: 0.5,
    auroraMaxAcu: 4,
    logRetentionDays: 30,
    enableMfa: envName === 'prod',
    // useCustomDomain intentionally omitted
  }
  const stack = new OrbitalHubStack(app, `OrbitalHub-${envName}-noFlag`, {
    envName,
    envConfig: config,
  })
  return Template.fromStack(stack)
}

// ---------------------------------------------------------------------------
// mwitt — useCustomDomain=false
// ---------------------------------------------------------------------------

describe('mwitt env (useCustomDomain=false)', () => {
  let template: Template

  beforeAll(() => {
    template = buildStack('mwitt', false)
  })

  test('has ZERO AWS::Route53::HostedZone resources', () => {
    template.resourceCountIs('AWS::Route53::HostedZone', 0)
  })

  test('has ZERO AWS::Route53::RecordSet resources', () => {
    template.resourceCountIs('AWS::Route53::RecordSet', 0)
  })

  test('has ZERO AWS::CertificateManager::Certificate resources', () => {
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0)
  })

  test('CloudFront distribution has no custom domain Aliases', () => {
    const distributions = template.findResources('AWS::CloudFront::Distribution')
    const cfDist = Object.values(distributions)[0] as {
      Properties: { DistributionConfig: Record<string, unknown> }
    }
    expect(cfDist?.Properties?.DistributionConfig?.Aliases).toBeUndefined()
  })

  test('CloudFront distribution has no AcmCertificateArn (uses default cloudfront.net cert)', () => {
    const distributions = template.findResources('AWS::CloudFront::Distribution')
    const cfDist = Object.values(distributions)[0] as {
      Properties: { DistributionConfig: { ViewerCertificate?: Record<string, unknown> } }
    }
    const vc = cfDist?.Properties?.DistributionConfig?.ViewerCertificate
    expect(vc?.AcmCertificateArn).toBeUndefined()
  })

  test('Cognito user pool domain uses AWS prefix (orbital-mwitt)', () => {
    // The prefix domain is: orbital-mwitt.auth.<region>.amazoncognito.com
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'orbital-mwitt',
    })
  })

  test('has no API Gateway custom domain names (HTTP API)', () => {
    // HTTP API V2 DomainName is AWS::ApiGatewayV2::DomainName
    template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0)
  })

  test('has no WebSocket API custom domain name (CfnDomainName)', () => {
    // WS uses CfnDomainName which maps to AWS::ApiGatewayV2::DomainName
    template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 0)
  })

  test('stack outputs include CognitoAuthDomain', () => {
    const outputs = template.findOutputs('*')
    const outputKeys = Object.keys(outputs)
    expect(outputKeys).toEqual(expect.arrayContaining([expect.stringContaining('CognitoAuthDomain')]))
  })

  test('stack outputs include CloudFrontDomain', () => {
    const outputs = template.findOutputs('*')
    const outputKeys = Object.keys(outputs)
    expect(outputKeys).toEqual(expect.arrayContaining([expect.stringContaining('CloudFrontDomain')]))
  })
})

// ---------------------------------------------------------------------------
// prod — useCustomDomain=true (unchanged)
// ---------------------------------------------------------------------------

describe('prod env (useCustomDomain=true)', () => {
  let template: Template

  beforeAll(() => {
    template = buildStack('prod', true)
  })

  test('has at least 1 AWS::Route53::HostedZone resource', () => {
    const zones = template.findResources('AWS::Route53::HostedZone')
    expect(Object.keys(zones).length).toBeGreaterThanOrEqual(1)
  })

  test('has at least 1 AWS::CertificateManager::Certificate resource', () => {
    const certs = template.findResources('AWS::CertificateManager::Certificate')
    expect(Object.keys(certs).length).toBeGreaterThanOrEqual(1)
  })

  test('has Route53 A records (custom domain wired)', () => {
    const records = template.findResources('AWS::Route53::RecordSet')
    expect(Object.keys(records).length).toBeGreaterThan(0)
  })

  test('CloudFront distribution has custom domain Aliases set', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Aliases: ['orbital.team.dev'],
      },
    })
  })
})

// ---------------------------------------------------------------------------
// rreed — useCustomDomain=true (unchanged)
// ---------------------------------------------------------------------------

describe('rreed env (useCustomDomain=true)', () => {
  let template: Template

  beforeAll(() => {
    template = buildStack('rreed', true)
  })

  test('has at least 1 AWS::Route53::HostedZone resource', () => {
    const zones = template.findResources('AWS::Route53::HostedZone')
    expect(Object.keys(zones).length).toBeGreaterThanOrEqual(1)
  })

  test('has at least 1 AWS::CertificateManager::Certificate resource', () => {
    const certs = template.findResources('AWS::CertificateManager::Certificate')
    expect(Object.keys(certs).length).toBeGreaterThanOrEqual(1)
  })

  test('CloudFront distribution has custom domain Aliases set', () => {
    template.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: {
        Aliases: ['rreed.orbital.team.dev'],
      },
    })
  })
})

// ---------------------------------------------------------------------------
// Backwards compatibility: omitting useCustomDomain defaults to true
// ---------------------------------------------------------------------------

describe('backwards compat — omitted useCustomDomain defaults to true', () => {
  test('stack without useCustomDomain flag creates Route53 HostedZone', () => {
    // Any env — use mwitt but without the flag set
    // This confirms the flag is optional and defaults to true when omitted.
    const template = buildStackOmitFlag('mwitt')
    const zones = template.findResources('AWS::Route53::HostedZone')
    expect(Object.keys(zones).length).toBeGreaterThanOrEqual(1)
  })

  test('stack without useCustomDomain flag creates ACM Certificate', () => {
    const template = buildStackOmitFlag('mwitt')
    const certs = template.findResources('AWS::CertificateManager::Certificate')
    expect(Object.keys(certs).length).toBeGreaterThanOrEqual(1)
  })
})
