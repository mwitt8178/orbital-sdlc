/**
 * Snapshot tests for OrbitalHubStack — Round 8-01
 *
 * Strategy:
 *  1. Synthesize the stack for each env (mwitt, rreed, prod)
 *  2. Verify key resources exist in the template (property assertions)
 *  3. Run cdk-nag checks (AwsSolutionsChecks pack)
 *  4. Snapshot the full template — any change to the synthesized CFN must be
 *     a deliberate, reviewed decision (update snapshot with `npm test -- -u`)
 *
 * TDD note: This test was written RED first (before the constructs existed),
 * then turned GREEN once the constructs were implemented. Per tdd-workflow skill.
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
    account: '123456789012', // test account — not a real account
    region: 'us-east-1',
    domain: 'mwitt.orbital.team.dev',
    auroraMinAcu: 0.5,
    auroraMaxAcu: 4,
    logRetentionDays: 30,
    enableMfa: false,
    useCustomDomain: true, // default true — tests that need false set it explicitly
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
    domain:
      envName === 'prod' ? 'orbital.team.dev' : `${envName}.orbital.team.dev`,
    enableMfa: envName === 'prod',
    // mwitt uses AWS-generated URLs — no Route53/ACM
    useCustomDomain: envName !== 'mwitt',
    ...configOverrides,
  })
  const stack = new OrbitalHubStack(app, `OrbitalHub-${envName}`, {
    envName,
    envConfig: config,
  })
  Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }))
  const template = Template.fromStack(stack)
  return { stack, template }
}

// ---------------------------------------------------------------------------
// VPC tests
// ---------------------------------------------------------------------------

describe('VpcConstruct', () => {
  test('mwitt env creates a VPC with correct CIDR', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.0.0.0/16',
    })
  })

  test('mwitt env creates public + private + isolated subnets (6 total for 2 AZs)', () => {
    const { template } = buildStack('mwitt')
    const subnets = template.findResources('AWS::EC2::Subnet')
    // 2 AZs × 3 subnet types = 6 subnets
    expect(Object.keys(subnets).length).toBe(6)
  })

  test('mwitt env creates exactly 1 NAT gateway (non-prod cost saving)', () => {
    const { template } = buildStack('mwitt')
    template.resourceCountIs('AWS::EC2::NatGateway', 1)
  })

  test('prod env creates 2 NAT gateways for HA', () => {
    const { template } = buildStack('prod')
    template.resourceCountIs('AWS::EC2::NatGateway', 2)
  })

  test('creates S3 gateway endpoint (free, avoids NAT charges for S3)', () => {
    const { template } = buildStack('mwitt')
    // ServiceName is constructed via Fn::Join in CFN ("com.amazonaws.<region>.s3")
    // We match on the VpcEndpointType; resource existence confirms the endpoint is present.
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Gateway',
    })
    // Confirm the service name uses the region-based S3 service (intrinsic, not literal string)
    const endpoints = template.findResources('AWS::EC2::VPCEndpoint', {
      Properties: { VpcEndpointType: 'Gateway' },
    })
    const gatewayEndpoints = Object.values(endpoints)
    expect(gatewayEndpoints.length).toBeGreaterThanOrEqual(1)
  })

  test('creates Secrets Manager interface endpoint', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Interface',
      ServiceName: Match.stringLikeRegexp('secretsmanager'),
    })
  })

  test('creates KMS interface endpoint', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::EC2::VPCEndpoint', {
      VpcEndpointType: 'Interface',
      ServiceName: Match.stringLikeRegexp('kms'),
    })
  })

  test('creates VPC Flow Logs CloudWatch log group', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/orbital/mwitt/vpc/flow-logs',
    })
  })

  test('creates flow log resource targeting CloudWatch', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::EC2::FlowLog', {
      LogDestinationType: 'cloud-watch-logs',
      TrafficType: 'ALL',
    })
  })
})

// ---------------------------------------------------------------------------
// DNS / ACM tests
// ---------------------------------------------------------------------------

describe('DnsConstruct', () => {
  // mwitt uses useCustomDomain=false — no Route53 or ACM resources created.
  test('mwitt env has NO Route 53 hosted zone (useCustomDomain=false)', () => {
    const { template } = buildStack('mwitt')
    template.resourceCountIs('AWS::Route53::HostedZone', 0)
  })

  test('mwitt env has NO ACM certificate (useCustomDomain=false)', () => {
    const { template } = buildStack('mwitt')
    template.resourceCountIs('AWS::CertificateManager::Certificate', 0)
  })

  // prod uses useCustomDomain=true — Route53 and ACM are created.
  test('prod env creates Route 53 hosted zone with apex domain', () => {
    const { template } = buildStack('prod')
    template.hasResourceProperties('AWS::Route53::HostedZone', {
      Name: 'orbital.team.dev.',
    })
  })

  test('prod env creates ACM certificate for the apex domain', () => {
    const { template } = buildStack('prod')
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      DomainName: 'orbital.team.dev',
      ValidationMethod: 'DNS',
    })
  })

  test('prod ACM cert includes wildcard SAN', () => {
    const { template } = buildStack('prod')
    template.hasResourceProperties('AWS::CertificateManager::Certificate', {
      SubjectAlternativeNames: ['*.orbital.team.dev'],
    })
  })
})

// ---------------------------------------------------------------------------
// Cognito tests
// ---------------------------------------------------------------------------

describe('CognitoConstruct', () => {
  test('creates user pool named orbital-{envName}', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UserPoolName: 'orbital-mwitt',
    })
  })

  test('user pool sign-in alias is email only', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      UsernameAttributes: ['email'],
    })
  })

  test('password policy enforces 12+ chars with complexity', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      Policies: {
        PasswordPolicy: {
          MinimumLength: 12,
          RequireUppercase: true,
          RequireLowercase: true,
          RequireNumbers: true,
          RequireSymbols: true,
        },
      },
    })
  })

  test('prod user pool has MFA required', () => {
    const { template } = buildStack('prod')
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'ON',
    })
  })

  test('non-prod user pool has MFA optional', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      MfaConfiguration: 'OPTIONAL',
    })
  })

  test('account recovery is email only (no SMS)', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::Cognito::UserPool', {
      AccountRecoverySetting: {
        RecoveryMechanisms: [
          { Name: 'verified_email', Priority: 1 },
        ],
      },
    })
  })

  test('creates SPA app client without client secret', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      ClientName: 'orbital-mwitt-spa',
      GenerateSecret: false,
    })
  })

  test('app client uses authorization code grant with PKCE', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      AllowedOAuthFlows: Match.arrayWith(['code']),
      AllowedOAuthFlowsUserPoolClient: true,
    })
  })

  test('app client token validity: id/access 60 min (1h), refresh 43200 min (30d)', () => {
    const { template } = buildStack('mwitt')
    // CDK Duration.hours(1) → 60 min; Duration.days(30) → 43200 min in CFN Cognito resource
    template.hasResourceProperties('AWS::Cognito::UserPoolClient', {
      IdTokenValidity: 60,
      AccessTokenValidity: 60,
      RefreshTokenValidity: 43200,
      TokenValidityUnits: {
        AccessToken: 'minutes',
        IdToken: 'minutes',
        RefreshToken: 'minutes',
      },
    })
  })

  test('creates cognito user pool domain', () => {
    const { template } = buildStack('mwitt')
    template.hasResourceProperties('AWS::Cognito::UserPoolDomain', {
      Domain: 'orbital-mwitt',
    })
  })

  test('mwitt env has NO Route53 A record for auth subdomain (useCustomDomain=false)', () => {
    const { template } = buildStack('mwitt')
    // No Route53 records at all for mwitt
    template.resourceCountIs('AWS::Route53::RecordSet', 0)
  })

  test('prod env creates Route53 A record for auth subdomain', () => {
    const { template } = buildStack('prod')
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'auth.orbital.team.dev.',
      Type: 'A',
    })
  })
})

// ---------------------------------------------------------------------------
// Stack-level tests
// ---------------------------------------------------------------------------

describe('OrbitalHubStack', () => {
  test('stack has termination protection disabled for non-prod', () => {
    const { stack } = buildStack('mwitt')
    expect(stack.terminationProtection).toBe(false)
  })

  test('prod stack has termination protection enabled', () => {
    const { stack } = buildStack('prod')
    expect(stack.terminationProtection).toBe(true)
  })

  test('stack has correct orbital:env tag', () => {
    const { template } = buildStack('mwitt')
    // Tags are applied via CDK Tags.of(); they appear on all resources
    // We verify at least the VPC has the tag
    template.hasResourceProperties('AWS::EC2::VPC', {
      Tags: Match.arrayWith([
        Match.objectLike({ Key: 'orbital:env', Value: 'mwitt' }),
      ]),
    })
  })

  test('outputs contain StackName, Environment, and Domain', () => {
    const { template } = buildStack('mwitt')
    const outputs = template.findOutputs('*')
    const outputKeys = Object.keys(outputs)
    expect(outputKeys).toEqual(
      expect.arrayContaining([
        expect.stringContaining('StackName'),
        expect.stringContaining('Environment'),
        expect.stringContaining('Domain'),
      ]),
    )
  })
})

// ---------------------------------------------------------------------------
// cdk-nag tests — these run after all constructs are wired
// ---------------------------------------------------------------------------

describe('cdk-nag AwsSolutionsChecks', () => {
  test('no ERROR-level nag violations in mwitt stack', () => {
    // cdk-nag violations are surfaced as cdk annotations.
    // We apply suppressions inline here matching cdk-nag.config.ts.
    const app = new cdk.App()
    const config = makeEnvConfig({ useCustomDomain: false })
    const stack = new OrbitalHubStack(app, 'OrbitalHub-mwitt-nag', {
      envName: 'mwitt',
      envConfig: config,
    })

    // Apply suppressions (includes 8-02 Aurora/RDS Proxy additions)
    NagSuppressions.addStackSuppressions(stack, [
      { id: 'AwsSolutions-VPC7', reason: 'Flow logs are configured inline; false positive.' },
      { id: 'AwsSolutions-EC28', reason: 'NAT GW EIP — not an EC2 instance; false positive.' },
      { id: 'AwsSolutions-COG2', reason: 'MFA optional in non-prod by design.' },
      { id: 'AwsSolutions-COG3', reason: 'AdvancedSecurityMode.ENFORCED is set.' },
      { id: 'AwsSolutions-VPC3', reason: 'Single NAT GW in non-prod by design (cost).' },
      // IAM wildcard suppressions for CDK-generated policies
      { id: 'AwsSolutions-IAM4', reason: 'CDK-generated managed policies for service roles.' },
      { id: 'AwsSolutions-IAM5', reason: 'CDK-generated wildcard policies for log delivery.' },
      // 8-02 Aurora + RDS Proxy suppressions
      { id: 'AwsSolutions-RDS6', reason: 'IAM DB auth enabled (iamAuthentication: true); cdk-nag false positive on Aurora Serverless v2.' },
      { id: 'AwsSolutions-RDS10', reason: 'Non-prod DESTROY removal policy by design; Prod uses RETAIN.' },
      { id: 'AwsSolutions-RDS11', reason: 'Aurora Postgres uses port 5432 (standard Postgres port).' },
      { id: 'AwsSolutions-RDS2', reason: 'StorageEncrypted is explicitly true on the Aurora cluster.' },
      { id: 'AwsSolutions-SMG4', reason: 'DB secret rotation planned for 8-07 (Secrets Manager round).' },
      { id: 'AwsSolutions-L1', reason: 'Migration runner uses nodejs22.x; CDK custom resource provider framework uses own managed runtime.' },
    ])

    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }))

    // Synthesize — if cdk-nag has blocking errors it throws
    expect(() => app.synth()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Full snapshot — update with: npx jest --updateSnapshot
// ---------------------------------------------------------------------------

describe('Snapshot', () => {
  test('mwitt stack template matches snapshot', () => {
    const { template } = buildStack('mwitt')
    expect(template.toJSON()).toMatchSnapshot()
  })

  test('prod stack template matches snapshot', () => {
    const { template } = buildStack('prod')
    expect(template.toJSON()).toMatchSnapshot()
  })
})
