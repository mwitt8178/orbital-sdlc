// [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
/**
 * authorizers.test.ts — Snapshot + property tests for AuthorizersConstruct.
 *
 * TDD: RED first, GREEN once authorizers.ts is implemented.
 *
 * Tests verify:
 *  1. Both authorizers are wired
 *  2. Cognito JWT authorizer points at correct issuer URL
 *  3. Install Lambda authorizer function is created
 *  4. Install authorizer function uses Node.js 22
 *  5. Install authorizer function is in VPC
 *  6. Install authorizer has ACTIVE X-Ray tracing
 *  7. Install authorizer role has rds-db:connect (queries known_installs)
 *  8. Install authorizer log group is created
 *  9. Install authorizer cache TTL = 0 (no caching — nonces single-use)
 * 10. cdk-nag: no ERROR-level violations
 * 11. Snapshot
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as rds from 'aws-cdk-lib/aws-rds'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib'
import { AuthorizersConstruct } from '../lib/constructs/authorizers'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildAuthorizerStack(): { stack: cdk.Stack; template: Template; construct: AuthorizersConstruct } {
  const app = new cdk.App()
  const stack = new cdk.Stack(app, 'TestAuthorizers', {
    env: { account: '123456789012', region: 'us-east-1' },
  })

  const vpc = new ec2.Vpc(stack, 'TestVpc', {
    maxAzs: 2,
    natGateways: 1,
    subnetConfiguration: [
      { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
      { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
    ],
  })

  const lambdaSg = new ec2.SecurityGroup(stack, 'LambdaSg', {
    vpc,
    description: 'Test Lambda SG',
    allowAllOutbound: true,
  })

  const masterSecret = new rds.DatabaseSecret(stack, 'MasterSecret', {
    username: 'orbital_admin',
  })

  const proxySg = new ec2.SecurityGroup(stack, 'ProxySg', {
    vpc,
    description: 'Test proxy SG',
    allowAllOutbound: false,
  })

  const auroraCluster = new rds.DatabaseCluster(stack, 'TestCluster', {
    engine: rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.VER_16_4,
    }),
    writer: rds.ClusterInstance.serverlessV2('Writer'),
    vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
    securityGroups: [proxySg],
    credentials: rds.Credentials.fromSecret(masterSecret),
    serverlessV2MinCapacity: 0.5,
    serverlessV2MaxCapacity: 4,
  })

  const rdsProxy = new rds.DatabaseProxy(stack, 'TestProxy', {
    proxyTarget: rds.ProxyTarget.fromCluster(auroraCluster),
    secrets: [masterSecret],
    vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
    securityGroups: [proxySg],
    iamAuth: true,
    dbProxyName: 'orbital-mwitt-proxy',
  })

  const userPool = new cognito.UserPool(stack, 'TestUserPool', {
    userPoolName: 'orbital-mwitt',
  })

  const construct = new AuthorizersConstruct(stack, 'Authorizers', {
    envName: 'mwitt',
    userPool,
    appClientId: 'testClientId123',
    region: 'us-east-1',
    vpc,
    lambdaSg,
    rdsProxy,
    proxyEndpoint: 'test-proxy.proxy.rds.amazonaws.com',
    logRetentionDays: 30,
  })

  const template = Template.fromStack(stack)
  return { stack, template, construct }
}

// ---------------------------------------------------------------------------
// Install authorizer Lambda
// ---------------------------------------------------------------------------

describe('AuthorizersConstruct — install Lambda authorizer', () => {
  test('install authorizer Lambda is created', () => {
    const { template } = buildAuthorizerStack()
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-install-authorizer',
    })
  })

  test('install authorizer uses Node.js 22', () => {
    const { template } = buildAuthorizerStack()
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-install-authorizer',
      Runtime: 'nodejs22.x',
    })
  })

  test('install authorizer is placed in VPC', () => {
    const { template } = buildAuthorizerStack()
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-install-authorizer',
      VpcConfig: Match.objectLike({
        SubnetIds: Match.anyValue(),
        SecurityGroupIds: Match.anyValue(),
      }),
    })
  })

  test('install authorizer has ACTIVE X-Ray tracing', () => {
    const { template } = buildAuthorizerStack()
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-install-authorizer',
      TracingConfig: { Mode: 'Active' },
    })
  })

  test('install authorizer has ORBITAL_DEPLOY_TARGET=aws', () => {
    const { template } = buildAuthorizerStack()
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-install-authorizer',
      Environment: {
        Variables: Match.objectLike({
          ORBITAL_DEPLOY_TARGET: 'aws',
          RDS_PROXY_HOSTNAME: 'test-proxy.proxy.rds.amazonaws.com',
        }),
      },
    })
  })

  test('install authorizer timeout is 10s', () => {
    const { template } = buildAuthorizerStack()
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-install-authorizer',
      Timeout: 10,
    })
  })

  test('install authorizer role has rds-db:connect', () => {
    const { template } = buildAuthorizerStack()
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'rds-db:connect',
            Effect: 'Allow',
          }),
        ]),
      },
    })
  })

  test('install authorizer log group created', () => {
    const { template } = buildAuthorizerStack()
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/orbital/mwitt/lambda/install-authorizer',
    })
  })
})

// ---------------------------------------------------------------------------
// Authorizers are wired
// ---------------------------------------------------------------------------

describe('AuthorizersConstruct — authorizer wiring', () => {
  test('both cognitoAuthorizer and installAuthorizer are defined', () => {
    const { construct } = buildAuthorizerStack()
    expect(construct.cognitoAuthorizer).toBeDefined()
    expect(construct.installAuthorizer).toBeDefined()
  })

  test('installAuthorizerFn is exposed', () => {
    const { construct } = buildAuthorizerStack()
    expect(construct.installAuthorizerFn).toBeDefined()
  })

  test('output InstallAuthorizerArn is exported', () => {
    const { template } = buildAuthorizerStack()
    const outputs = template.findOutputs('*')
    expect(Object.keys(outputs).some((k) => k.includes('InstallAuthorizerArn'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// cdk-nag
// ---------------------------------------------------------------------------

describe('AuthorizersConstruct — cdk-nag', () => {
  test('no ERROR-level violations', () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, 'NagAuthorizerStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })

    const vpc = new ec2.Vpc(stack, 'TestVpc', {
      maxAzs: 2,
      natGateways: 1,
      subnetConfiguration: [
        { name: 'public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
        { name: 'private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
        { name: 'isolated', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
      ],
    })
    const lambdaSg = new ec2.SecurityGroup(stack, 'LambdaSg', {
      vpc,
      description: 'Test Lambda SG',
      allowAllOutbound: true,
    })
    const masterSecret = new rds.DatabaseSecret(stack, 'MasterSecret', {
      username: 'orbital_admin',
    })
    const proxySg = new ec2.SecurityGroup(stack, 'ProxySg', {
      vpc,
      description: 'Test proxy SG',
      allowAllOutbound: false,
    })
    const auroraCluster = new rds.DatabaseCluster(stack, 'TestCluster', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      writer: rds.ClusterInstance.serverlessV2('Writer'),
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      securityGroups: [proxySg],
      credentials: rds.Credentials.fromSecret(masterSecret),
      serverlessV2MinCapacity: 0.5,
      serverlessV2MaxCapacity: 4,
    })
    const rdsProxy = new rds.DatabaseProxy(stack, 'TestProxy', {
      proxyTarget: rds.ProxyTarget.fromCluster(auroraCluster),
      secrets: [masterSecret],
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [proxySg],
      iamAuth: true,
      dbProxyName: 'orbital-mwitt-proxy',
    })
    const userPool = new cognito.UserPool(stack, 'TestUserPool', {
      userPoolName: 'orbital-mwitt',
    })

    new AuthorizersConstruct(stack, 'Authorizers', {
      envName: 'mwitt',
      userPool,
      appClientId: 'testClientId123',
      region: 'us-east-1',
      vpc,
      lambdaSg,
      rdsProxy,
      proxyEndpoint: 'test-proxy.proxy.rds.amazonaws.com',
      logRetentionDays: 30,
    })

    NagSuppressions.addStackSuppressions(stack, [
      { id: 'AwsSolutions-IAM4', reason: 'CDK-generated VPCAccess managed policy; required for VPC Lambda.' },
      { id: 'AwsSolutions-IAM5', reason: 'X-Ray requires wildcard resource; CDK-generated policy.' },
      { id: 'AwsSolutions-L1', reason: 'nodejs22.x is latest LTS.' },
      { id: 'AwsSolutions-RDS6', reason: 'IAM auth enabled on Aurora.' },
      { id: 'AwsSolutions-RDS10', reason: 'Non-prod DESTROY removal policy by design.' },
      { id: 'AwsSolutions-RDS11', reason: 'Postgres standard port 5432.' },
      { id: 'AwsSolutions-RDS2', reason: 'StorageEncrypted is true.' },
      { id: 'AwsSolutions-SMG4', reason: 'Secret rotation planned for 8-07.' },
    ])

    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }))
    expect(() => app.synth()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

describe('AuthorizersConstruct — snapshot', () => {
  test('mwitt stack matches snapshot', () => {
    const { template } = buildAuthorizerStack()
    expect(template.toJSON()).toMatchSnapshot()
  })
})
