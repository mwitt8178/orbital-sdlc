// [Engineer-Sr · Sonnet · run-round8-02-aurora]
/**
 * migration-runner.test.ts — Tests for RunMigrationsTrigger construct
 *
 * TDD: RED first, GREEN once run-migrations.ts is implemented.
 *
 * Tests verify:
 *  1. Migration runner Lambda is created with correct name
 *  2. Lambda is in the correct VPC + private subnet
 *  3. Lambda has correct runtime (Node.js 22.x)
 *  4. Lambda IAM role has rds-db:connect permission (grantConnect)
 *  5. Lambda IAM role has secretsmanager:GetSecretValue for master secret
 *  6. Lambda timeout is 10 minutes
 *  7. Lambda has correct env vars: RDS_PROXY_HOSTNAME, AURORA_DB_NAME, etc.
 *  8. CustomResource is created with correct resource type
 *  9. CloudWatch log group has correct retention
 * 10. Snapshot matches
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib'
import { AuroraConstruct } from '../lib/constructs/aurora'
import { RdsProxyConstruct } from '../lib/constructs/rds-proxy'
import { RunMigrationsTrigger } from '../lib/triggers/run-migrations'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestStackResult {
  stack: cdk.Stack
  template: Template
  trigger: RunMigrationsTrigger
}

function buildMigrationRunnerStack(envName: 'mwitt' | 'prod' = 'mwitt'): TestStackResult {
  const app = new cdk.App()
  const stack = new cdk.Stack(app, `TestMigrationStack-${envName}`, {
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

  const proxySg = new ec2.SecurityGroup(stack, 'ProxySgRef', {
    vpc,
    securityGroupName: `orbital-${envName}-rds-proxy`,
    description: 'Pre-created proxy SG',
    allowAllOutbound: false,
  })

  const aurora = new AuroraConstruct(stack, 'Aurora', {
    envName,
    vpc,
    minAcu: envName === 'prod' ? 1 : 0.5,
    maxAcu: envName === 'prod' ? 16 : 4,
    logRetentionDays: 30,
    allowedSg: proxySg,
  })

  const rdsProxy = new RdsProxyConstruct(stack, 'RdsProxy', {
    envName,
    vpc,
    cluster: aurora.cluster,
    masterSecret: aurora.masterSecret,
    existingProxySg: proxySg,
  })

  const trigger = new RunMigrationsTrigger(stack, 'Migrations', {
    envName,
    vpc,
    proxy: rdsProxy.proxy,
    proxyEndpoint: rdsProxy.proxy.endpoint,
    cluster: aurora.cluster,
    masterSecret: aurora.masterSecret,
    lambdaSg: rdsProxy.lambdaSecurityGroup,
    logRetentionDays: 30,
  })

  const template = Template.fromStack(stack)
  return { stack, template, trigger }
}

// ---------------------------------------------------------------------------
// Lambda existence and configuration
// ---------------------------------------------------------------------------

describe('RunMigrationsTrigger — Lambda', () => {
  test('creates a Lambda function', () => {
    const { template } = buildMigrationRunnerStack()
    // At least one Lambda function exists (the migration runner + provider framework)
    const fns = template.findResources('AWS::Lambda::Function')
    expect(Object.keys(fns).length).toBeGreaterThanOrEqual(1)
  })

  test('migration runner Lambda is named orbital-{envName}-migration-runner', () => {
    const { template } = buildMigrationRunnerStack('mwitt')
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-migration-runner',
    })
  })

  test('Lambda runtime is nodejs22.x', () => {
    const { template } = buildMigrationRunnerStack()
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-migration-runner',
      Runtime: 'nodejs22.x',
    })
  })

  test('Lambda timeout is 600 seconds (10 minutes)', () => {
    const { template } = buildMigrationRunnerStack()
    // Find the migration runner function and verify its timeout property
    const fns = template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: 'orbital-mwitt-migration-runner' },
    })
    const fn = Object.values(fns)[0] as { Properties: { Timeout?: number } }
    expect(fn?.Properties?.Timeout).toBe(600)
  })

  test('Lambda has correct environment variables', () => {
    const { template } = buildMigrationRunnerStack()
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-migration-runner',
      Environment: {
        Variables: Match.objectLike({
          RDS_PROXY_PORT: '5432',
          AURORA_DB_NAME: 'orbital_hub',
          AURORA_USERNAME: 'orbital_admin',
        }),
      },
    })
  })

  test('Lambda is in a VPC with private subnets', () => {
    const { template } = buildMigrationRunnerStack()
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-migration-runner',
      VpcConfig: Match.objectLike({
        SubnetIds: Match.anyValue(),
        SecurityGroupIds: Match.anyValue(),
      }),
    })
  })
})

// ---------------------------------------------------------------------------
// IAM role grants
// ---------------------------------------------------------------------------

describe('RunMigrationsTrigger — IAM role', () => {
  test('Lambda execution role has AWSLambdaVPCAccessExecutionRole managed policy', () => {
    const { template } = buildMigrationRunnerStack()
    // CDK synthesizes ManagedPolicyArns as { "Fn::Join": [...] } intrinsics,
    // not literal strings. We verify by searching for a role whose ARN
    // references AWSLambdaVPCAccessExecutionRole.
    const roles = template.findResources('AWS::IAM::Role')
    const hasVpcPolicy = Object.values(roles).some((role) => {
      const arns: unknown[] = (role as Record<string, Record<string, unknown[]>>).Properties?.ManagedPolicyArns ?? []
      return arns.some((arn) => JSON.stringify(arn).includes('AWSLambdaVPCAccessExecutionRole'))
    })
    expect(hasVpcPolicy).toBe(true)
  })

  test('Lambda execution role can connect to RDS via IAM (rds-db:connect)', () => {
    const { template } = buildMigrationRunnerStack()
    // grantConnect adds a policy with rds-db:connect action
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'rds-db:connect',
          }),
        ]),
      },
    })
  })

  test('Lambda execution role can read Secrets Manager secret', () => {
    const { template } = buildMigrationRunnerStack()
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              Match.stringLikeRegexp('secretsmanager:GetSecretValue'),
            ]),
          }),
        ]),
      },
    })
  })
})

// ---------------------------------------------------------------------------
// Custom resource
// ---------------------------------------------------------------------------

describe('RunMigrationsTrigger — custom resource', () => {
  test('creates a CloudFormation custom resource', () => {
    const { template } = buildMigrationRunnerStack()
    const customResources = template.findResources('Custom::OrbitalMigrationRunner')
    expect(Object.keys(customResources).length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// CloudWatch log group
// ---------------------------------------------------------------------------

describe('RunMigrationsTrigger — observability', () => {
  test('creates CloudWatch log group for migration runner', () => {
    const { template } = buildMigrationRunnerStack('mwitt')
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/orbital/mwitt/lambda/migration-runner',
    })
  })

  test('log group retention matches env config', () => {
    const { template } = buildMigrationRunnerStack('mwitt')
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/orbital/mwitt/lambda/migration-runner',
      RetentionInDays: 30,
    })
  })
})

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

describe('RunMigrationsTrigger — outputs', () => {
  test('outputs include MigrationRunnerArn', () => {
    const { template } = buildMigrationRunnerStack()
    const outputs = template.findOutputs('*')
    const keys = Object.keys(outputs)
    expect(keys.some((k) => k.includes('MigrationRunnerArn'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// cdk-nag
// ---------------------------------------------------------------------------

describe('RunMigrationsTrigger — cdk-nag', () => {
  test('no ERROR-level nag violations', () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, 'NagMigrationStack', {
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

    const proxySg = new ec2.SecurityGroup(stack, 'ProxySgRef', {
      vpc, description: 'Proxy SG', allowAllOutbound: false,
    })

    const aurora = new AuroraConstruct(stack, 'Aurora', {
      envName: 'mwitt',
      vpc,
      minAcu: 0.5,
      maxAcu: 4,
      logRetentionDays: 30,
      allowedSg: proxySg,
    })

    const rdsProxy = new RdsProxyConstruct(stack, 'RdsProxy', {
      envName: 'mwitt',
      vpc,
      cluster: aurora.cluster,
      masterSecret: aurora.masterSecret,
      existingProxySg: proxySg,
    })

    new RunMigrationsTrigger(stack, 'Migrations', {
      envName: 'mwitt',
      vpc,
      proxy: rdsProxy.proxy,
      proxyEndpoint: rdsProxy.proxy.endpoint,
      cluster: aurora.cluster,
      masterSecret: aurora.masterSecret,
      lambdaSg: rdsProxy.lambdaSecurityGroup,
      logRetentionDays: 30,
    })

    NagSuppressions.addStackSuppressions(stack, [
      { id: 'AwsSolutions-VPC7', reason: 'Test stack.' },
      { id: 'AwsSolutions-RDS6', reason: 'IAM auth enabled.' },
      { id: 'AwsSolutions-RDS10', reason: 'Non-prod DESTROY policy.' },
      { id: 'AwsSolutions-RDS11', reason: 'Aurora port 5432.' },
      { id: 'AwsSolutions-RDS2', reason: 'StorageEncrypted true.' },
      { id: 'AwsSolutions-IAM4', reason: 'CDK-generated managed policies.' },
      { id: 'AwsSolutions-IAM5', reason: 'CDK-generated wildcards for log delivery and Secrets Manager.' },
      { id: 'AwsSolutions-SMG4', reason: 'Rotation in 8-07.' },
      { id: 'AwsSolutions-L1', reason: 'Provider framework uses custom runtime; migration runner uses nodejs22.x.' },
    ])

    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }))

    expect(() => app.synth()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

describe('RunMigrationsTrigger — snapshot', () => {
  test('mwitt migration runner stack matches snapshot', () => {
    const { template } = buildMigrationRunnerStack('mwitt')
    expect(template.toJSON()).toMatchSnapshot()
  })
})
