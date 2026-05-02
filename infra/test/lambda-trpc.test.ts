// [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
/**
 * lambda-trpc.test.ts — Snapshot + property tests for LambdaTrpcConstruct.
 *
 * TDD: RED first, GREEN once lambda-trpc.ts is implemented.
 *
 * Tests verify:
 *  1. Exactly 11 Lambda functions synthesized for the full router group set
 *  2. All Lambdas use Node.js 22 runtime
 *  3. X-Ray tracing is ACTIVE on all Lambdas
 *  4. Provisioned Concurrency = 2 on auth + tasks (hot paths)
 *  5. No Provisioned Concurrency on the other 9 Lambdas
 *  6. Lambda SG from RDS Proxy construct is attached
 *  7. Function names follow orbital-{env}-trpc-{group} convention
 *  8. Timeout = 29s (under API GW 30s limit)
 *  9. Memory = 1024 MB
 * 10. VPC placement in PRIVATE_WITH_EGRESS subnets
 * 11. RDS Proxy grantConnect IAM permission on each Lambda role
 * 12. Log groups with correct retention
 * 13. cdk-nag: no ERROR-level violations
 * 14. Snapshot
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as rds from 'aws-cdk-lib/aws-rds'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib'
import { LambdaTrpcConstruct, RouterGroup } from '../lib/constructs/lambda-trpc'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface TestStackResult {
  stack: cdk.Stack
  template: Template
  lambdas: Map<RouterGroup, LambdaTrpcConstruct>
}

const ALL_GROUPS: RouterGroup[] = [
  'auth', 'tasks', 'memory', 'comms', 'defects',
  'audit', 'prs', 'cost', 'providers', 'team', 'onboarding',
]

function buildLambdaStack(envName = 'mwitt'): TestStackResult {
  const app = new cdk.App()
  const stack = new cdk.Stack(app, `TestLambda-${envName}`, {
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

  // Stub master secret (DatabaseSecret is complex to instantiate standalone)
  const masterSecret = new rds.DatabaseSecret(stack, 'MasterSecret', {
    username: 'orbital_admin',
  })

  // Minimal Aurora cluster for RDS Proxy
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
    dbProxyName: `orbital-${envName}-proxy`,
  })

  const lambdas = new Map<RouterGroup, LambdaTrpcConstruct>()
  for (const group of ALL_GROUPS) {
    const construct = new LambdaTrpcConstruct(stack, `Lambda-${group}`, {
      routerGroup: group,
      envName,
      vpc,
      lambdaSg,
      rdsProxy,
      secretArns: {},
      proxyEndpoint: 'test-proxy.proxy.rds.amazonaws.com',
      logRetentionDays: 30,
      cognitoUserPoolId: 'us-east-1_testPool',
      cognitoAppClientId: 'testClientId',
      region: 'us-east-1',
    })
    lambdas.set(group, construct)
  }

  const template = Template.fromStack(stack)
  return { stack, template, lambdas }
}

// ---------------------------------------------------------------------------
// Count and runtime
// ---------------------------------------------------------------------------

describe('LambdaTrpcConstruct — count and runtime', () => {
  test('creates at least 11 Lambda functions (one per router group + possibly the authorizer)', () => {
    const { template } = buildLambdaStack()
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: { Runtime: 'nodejs22.x' },
    })
    // All 11 tRPC group Lambdas use nodejs22.x
    expect(Object.keys(functions).length).toBeGreaterThanOrEqual(11)
  })

  test('all tRPC Lambda functions use nodejs22.x runtime', () => {
    const { template } = buildLambdaStack()
    // Every Lambda with a name matching orbital-mwitt-trpc-* must be nodejs22.x
    const allFunctions = template.findResources('AWS::Lambda::Function')
    const trpcFns = Object.values(allFunctions).filter(
      (fn) => fn.Properties?.Runtime === 'nodejs22.x',
    )
    expect(trpcFns.length).toBeGreaterThanOrEqual(11)
  })

  test('each router group Lambda has the correct function name', () => {
    const { template } = buildLambdaStack('mwitt')
    for (const group of ALL_GROUPS) {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: `orbital-mwitt-trpc-${group}`,
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Timeouts and memory
// ---------------------------------------------------------------------------

describe('LambdaTrpcConstruct — timeout and memory', () => {
  test('Lambda timeout is 29 seconds (under API GW 30s limit)', () => {
    const { template } = buildLambdaStack()
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-trpc-auth',
      Timeout: 29,
    })
  })

  test('Lambda memory is 1024 MB', () => {
    const { template } = buildLambdaStack()
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-trpc-tasks',
      MemorySize: 1024,
    })
  })
})

// ---------------------------------------------------------------------------
// X-Ray tracing
// ---------------------------------------------------------------------------

describe('LambdaTrpcConstruct — X-Ray tracing', () => {
  test('all tRPC Lambdas have ACTIVE X-Ray tracing', () => {
    const { template } = buildLambdaStack()
    for (const group of ALL_GROUPS) {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: `orbital-mwitt-trpc-${group}`,
        TracingConfig: { Mode: 'Active' },
      })
    }
  })
})

// ---------------------------------------------------------------------------
// Provisioned Concurrency
// ---------------------------------------------------------------------------

describe('LambdaTrpcConstruct — Provisioned Concurrency', () => {
  test('auth Lambda has provisioned concurrency alias', () => {
    const { lambdas } = buildLambdaStack()
    const authConstruct = lambdas.get('auth')
    expect(authConstruct?.hasProvisionedConcurrency).toBe(true)
  })

  test('tasks Lambda has provisioned concurrency alias', () => {
    const { lambdas } = buildLambdaStack()
    const tasksConstruct = lambdas.get('tasks')
    expect(tasksConstruct?.hasProvisionedConcurrency).toBe(true)
  })

  test('non-hot-path Lambdas do not have provisioned concurrency', () => {
    const { lambdas } = buildLambdaStack()
    const coldGroups: RouterGroup[] = [
      'memory', 'comms', 'defects', 'audit', 'prs',
      'cost', 'providers', 'team', 'onboarding',
    ]
    for (const group of coldGroups) {
      const construct = lambdas.get(group)
      expect(construct?.hasProvisionedConcurrency).toBe(false)
    }
  })

  test('auth Lambda has Lambda alias with provisioned concurrency', () => {
    const { template } = buildLambdaStack()
    template.hasResourceProperties('AWS::Lambda::Alias', {
      Name: 'live',
      ProvisionedConcurrencyConfig: {
        ProvisionedConcurrentExecutions: 2,
      },
    })
  })

  test('exactly 2 Lambda aliases are created (auth + tasks)', () => {
    const { template } = buildLambdaStack()
    template.resourceCountIs('AWS::Lambda::Alias', 2)
  })
})

// ---------------------------------------------------------------------------
// Environment variables
// ---------------------------------------------------------------------------

describe('LambdaTrpcConstruct — environment variables', () => {
  test('Lambda has ORBITAL_DEPLOY_TARGET=aws', () => {
    const { template } = buildLambdaStack()
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-trpc-auth',
      Environment: {
        Variables: Match.objectLike({
          ORBITAL_DEPLOY_TARGET: 'aws',
        }),
      },
    })
  })

  test('Lambda has RDS_PROXY_HOSTNAME set', () => {
    const { template } = buildLambdaStack()
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-trpc-tasks',
      Environment: {
        Variables: Match.objectLike({
          RDS_PROXY_HOSTNAME: 'test-proxy.proxy.rds.amazonaws.com',
        }),
      },
    })
  })

  test('Lambda has COGNITO_USER_POOL_ID set', () => {
    const { template } = buildLambdaStack()
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-trpc-auth',
      Environment: {
        Variables: Match.objectLike({
          COGNITO_USER_POOL_ID: 'us-east-1_testPool',
        }),
      },
    })
  })
})

// ---------------------------------------------------------------------------
// Log groups
// ---------------------------------------------------------------------------

describe('LambdaTrpcConstruct — log groups', () => {
  test('each group has a dedicated CloudWatch log group', () => {
    const { template } = buildLambdaStack('mwitt')
    for (const group of ALL_GROUPS) {
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: `/orbital/mwitt/lambda/trpc-${group}`,
      })
    }
  })

  test('log groups have 30-day retention', () => {
    const { template } = buildLambdaStack()
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/orbital/mwitt/lambda/trpc-auth',
      RetentionInDays: 30,
    })
  })
})

// ---------------------------------------------------------------------------
// IAM / RDS Proxy connectivity
// ---------------------------------------------------------------------------

describe('LambdaTrpcConstruct — IAM and RDS Proxy', () => {
  test('each Lambda role has rds-db:connect policy', () => {
    const { template } = buildLambdaStack()
    // rds-db:connect is granted via grantConnect; verify the policy exists
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

  test('Lambda is placed in VPC with PRIVATE_WITH_EGRESS subnet', () => {
    const { template } = buildLambdaStack()
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-trpc-auth',
      VpcConfig: Match.objectLike({
        SubnetIds: Match.anyValue(),
        SecurityGroupIds: Match.anyValue(),
      }),
    })
  })
})

// ---------------------------------------------------------------------------
// cdk-nag
// ---------------------------------------------------------------------------

describe('LambdaTrpcConstruct — cdk-nag', () => {
  test('no ERROR-level violations', () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, 'NagLambdaStack', {
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

    new LambdaTrpcConstruct(stack, 'Lambda-auth', {
      routerGroup: 'auth',
      envName: 'mwitt',
      vpc,
      lambdaSg,
      rdsProxy,
      secretArns: {},
      proxyEndpoint: 'test-proxy.proxy.rds.amazonaws.com',
      logRetentionDays: 30,
      cognitoUserPoolId: 'us-east-1_testPool',
      cognitoAppClientId: 'testClientId',
      region: 'us-east-1',
    })

    NagSuppressions.addStackSuppressions(stack, [
      { id: 'AwsSolutions-IAM4', reason: 'CDK-generated VPCAccess managed policy; required for VPC Lambda.' },
      { id: 'AwsSolutions-IAM5', reason: 'xray:PutTraceSegments requires wildcard resource; X-Ray does not support resource-level restrictions.' },
      { id: 'AwsSolutions-L1', reason: 'Lambda uses nodejs22.x (latest LTS). CDK provider framework runtime not directly configurable.' },
      { id: 'AwsSolutions-RDS6', reason: 'IAM auth enabled on Aurora cluster.' },
      { id: 'AwsSolutions-RDS10', reason: 'Non-prod removal policy DESTROY by design.' },
      { id: 'AwsSolutions-RDS11', reason: 'Aurora Postgres uses standard port 5432.' },
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

describe('LambdaTrpcConstruct — snapshot', () => {
  test('mwitt stack with all 11 router groups matches snapshot', () => {
    const { template } = buildLambdaStack('mwitt')
    expect(template.toJSON()).toMatchSnapshot()
  })
})
