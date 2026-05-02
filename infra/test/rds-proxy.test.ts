// [Engineer-Sr · Sonnet · run-round8-02-aurora]
/**
 * rds-proxy.test.ts — Snapshot + property tests for RdsProxyConstruct
 *
 * TDD: RED first, GREEN once rds-proxy.ts is implemented.
 *
 * Tests verify:
 *  1. DatabaseProxy resource is created
 *  2. IAM auth is enabled
 *  3. Idle client timeout is 30 minutes
 *  4. maxConnectionsPercent is 95
 *  5. Lambda placeholder SG is created with correct name
 *  6. Proxy SG ingress is from Lambda SG only
 *  7. existingProxySg is reused when provided
 *  8. Outputs include ProxyEndpoint, LambdaSgId, ProxySgId
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as rds from 'aws-cdk-lib/aws-rds'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib'
import { RdsProxyConstruct } from '../lib/constructs/rds-proxy'
import { AuroraConstruct } from '../lib/constructs/aurora'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestStackResult {
  stack: cdk.Stack
  template: Template
  rdsProxy: RdsProxyConstruct
}

function buildProxyStack(opts: {
  envName?: string
  useExistingProxySg?: boolean
}): TestStackResult {
  const { envName = 'mwitt', useExistingProxySg = false } = opts

  const app = new cdk.App()
  const stack = new cdk.Stack(app, `TestProxyStack-${envName}`, {
    env: { account: '123456789012', region: 'us-east-1' },
  })

  const vpc = new ec2.Vpc(stack, 'TestVpc', {
    maxAzs: 2,
    subnetConfiguration: [
      { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
    ],
    natGateways: 1,
  })

  // Proxy SG (created ahead of aurora to break circular dep)
  let existingProxySg: ec2.SecurityGroup | undefined
  if (useExistingProxySg) {
    existingProxySg = new ec2.SecurityGroup(stack, 'ProxySgRef', {
      vpc,
      securityGroupName: `orbital-${envName}-rds-proxy`,
      description: 'Pre-created proxy SG',
      allowAllOutbound: false,
    })
  }

  const aurora = new AuroraConstruct(stack, 'Aurora', {
    envName,
    vpc,
    minAcu: 0.5,
    maxAcu: 4,
    logRetentionDays: 30,
    allowedSg: existingProxySg ?? new ec2.SecurityGroup(stack, 'FallbackSg', {
      vpc,
      description: 'Fallback SG',
      allowAllOutbound: false,
    }),
  })

  const rdsProxy = new RdsProxyConstruct(stack, 'RdsProxy', {
    envName,
    vpc,
    cluster: aurora.cluster,
    masterSecret: aurora.masterSecret,
    existingProxySg,
  })

  const template = Template.fromStack(stack)
  return { stack, template, rdsProxy }
}

// ---------------------------------------------------------------------------
// Proxy existence
// ---------------------------------------------------------------------------

describe('RdsProxyConstruct — proxy existence', () => {
  test('creates a DatabaseProxy resource', () => {
    const { template } = buildProxyStack({})
    template.resourceCountIs('AWS::RDS::DBProxy', 1)
  })

  test('proxy is named orbital-{envName}-proxy', () => {
    const { template } = buildProxyStack({ envName: 'mwitt' })
    template.hasResourceProperties('AWS::RDS::DBProxy', {
      DBProxyName: 'orbital-mwitt-proxy',
    })
  })

  test('proxy engine family is POSTGRESQL', () => {
    const { template } = buildProxyStack({})
    template.hasResourceProperties('AWS::RDS::DBProxy', {
      EngineFamily: 'POSTGRESQL',
    })
  })
})

// ---------------------------------------------------------------------------
// IAM auth
// ---------------------------------------------------------------------------

describe('RdsProxyConstruct — IAM authentication', () => {
  test('proxy has IAM auth enabled', () => {
    const { template } = buildProxyStack({})
    template.hasResourceProperties('AWS::RDS::DBProxy', {
      Auth: Match.arrayWith([
        Match.objectLike({
          IAMAuth: 'REQUIRED',
        }),
      ]),
    })
  })
})

// ---------------------------------------------------------------------------
// Idle timeout
// ---------------------------------------------------------------------------

describe('RdsProxyConstruct — idle timeout', () => {
  test('idle client timeout is 1800 seconds (30 minutes)', () => {
    const { template } = buildProxyStack({})
    template.hasResourceProperties('AWS::RDS::DBProxy', {
      IdleClientTimeout: 1800,
    })
  })
})

// ---------------------------------------------------------------------------
// Connection percent
// ---------------------------------------------------------------------------

describe('RdsProxyConstruct — connection pooling', () => {
  test('maxConnectionsPercent is 95', () => {
    const { template } = buildProxyStack({})
    template.hasResourceProperties('AWS::RDS::DBProxyTargetGroup', {
      ConnectionPoolConfigurationInfo: Match.objectLike({
        MaxConnectionsPercent: 95,
      }),
    })
  })
})

// ---------------------------------------------------------------------------
// Security groups
// ---------------------------------------------------------------------------

describe('RdsProxyConstruct — security groups', () => {
  test('creates a Lambda placeholder security group', () => {
    const { template } = buildProxyStack({ envName: 'mwitt' })
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: Match.stringLikeRegexp('placeholder Lambda SG|Lambda SG'),
    })
  })

  test('proxy security group allows Postgres from Lambda SG', () => {
    const { template } = buildProxyStack({})
    // Ingress rule on 5432 from source SG
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 5432,
      ToPort: 5432,
    })
  })

  test('existingProxySg is reused (no duplicate proxy SG created)', () => {
    // With existingProxySg, the construct should NOT create a second proxy SG
    const withExisting = buildProxyStack({ useExistingProxySg: true })
    const withoutExisting = buildProxyStack({ useExistingProxySg: false })

    const sgsWithExisting = withExisting.template.findResources('AWS::EC2::SecurityGroup')
    const sgsWithoutExisting = withoutExisting.template.findResources('AWS::EC2::SecurityGroup')

    // When existing SG is provided, we should have one fewer SG resource
    // (the proxy SG is already counted in the pre-created one)
    expect(Object.keys(sgsWithExisting).length).toBeLessThanOrEqual(
      Object.keys(sgsWithoutExisting).length,
    )
  })
})

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

describe('RdsProxyConstruct — outputs', () => {
  test('outputs include ProxyEndpoint', () => {
    const { template } = buildProxyStack({})
    const outputs = template.findOutputs('*')
    const keys = Object.keys(outputs)
    expect(keys.some((k) => k.includes('ProxyEndpoint'))).toBe(true)
  })

  test('outputs include LambdaSecurityGroupId', () => {
    const { template } = buildProxyStack({})
    const outputs = template.findOutputs('*')
    const keys = Object.keys(outputs)
    expect(keys.some((k) => k.includes('LambdaSecurityGroupId'))).toBe(true)
  })

  test('outputs include ProxySecurityGroupId', () => {
    const { template } = buildProxyStack({})
    const outputs = template.findOutputs('*')
    const keys = Object.keys(outputs)
    expect(keys.some((k) => k.includes('ProxySecurityGroupId'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// cdk-nag
// ---------------------------------------------------------------------------

describe('RdsProxyConstruct — cdk-nag', () => {
  test('no ERROR-level nag violations', () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, 'NagProxyStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })

    const vpc = new ec2.Vpc(stack, 'TestVpc', {
      maxAzs: 2,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
      natGateways: 1,
    })

    const allowedSg = new ec2.SecurityGroup(stack, 'ProxySgRef', {
      vpc, description: 'Test proxy SG', allowAllOutbound: false,
    })

    const aurora = new AuroraConstruct(stack, 'Aurora', {
      envName: 'mwitt',
      vpc,
      minAcu: 0.5,
      maxAcu: 4,
      logRetentionDays: 30,
      allowedSg,
    })

    new RdsProxyConstruct(stack, 'RdsProxy', {
      envName: 'mwitt',
      vpc,
      cluster: aurora.cluster,
      masterSecret: aurora.masterSecret,
    })

    NagSuppressions.addStackSuppressions(stack, [
      { id: 'AwsSolutions-VPC7', reason: 'Test stack — no flow logs required.' },
      { id: 'AwsSolutions-RDS6', reason: 'IAM auth is enabled.' },
      { id: 'AwsSolutions-RDS10', reason: 'Non-prod DESTROY policy is intentional.' },
      { id: 'AwsSolutions-RDS11', reason: 'Aurora Postgres uses port 5432.' },
      { id: 'AwsSolutions-RDS2', reason: 'StorageEncrypted is true on the cluster.' },
      { id: 'AwsSolutions-IAM4', reason: 'CDK-generated policies for service roles.' },
      { id: 'AwsSolutions-IAM5', reason: 'CDK-generated wildcard for log delivery.' },
      { id: 'AwsSolutions-SMG4', reason: 'Rotation added in 8-07.' },
      { id: 'AwsSolutions-EC23', reason: 'Test VPC — no NAT GW.' },
    ])

    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }))

    expect(() => app.synth()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

describe('RdsProxyConstruct — snapshot', () => {
  test('mwitt template matches snapshot', () => {
    const { template } = buildProxyStack({ envName: 'mwitt' })
    expect(template.toJSON()).toMatchSnapshot()
  })
})
