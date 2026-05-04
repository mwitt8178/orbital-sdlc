/**
 * api-stack.ts — API Gateway HTTP + WS, api-lambda, install-lambda,
 * ws-connect/disconnect/default/fanout lambdas, authorizers,
 * DynamoDB connections table.
 *
 * Phase 4 stack split: resources are instantiated directly on the parent scope
 * so logical IDs stay identical to the monolith.
 */
import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as path from 'path'
import { Construct } from 'constructs'
import { CognitoConstruct } from '../constructs/cognito'
import { ApiLambdaConstruct } from '../constructs/api-lambda'
import { LambdaTrpcConstruct, RouterGroup } from '../constructs/lambda-trpc'
import { ApiGwHttpConstruct } from '../constructs/api-gw-http'
import { AuthorizersConstruct } from '../constructs/authorizers'
import { DynamoDbConnectionsConstruct } from '../constructs/dynamodb-connections'
import { ApiGwWsConstruct } from '../constructs/api-gw-ws'
import { DnsConstruct } from '../constructs/dns'
import { EnvConfig } from '../orbital-hub-stack'

export interface ApiOutputs {
  readonly apiLambda: ApiLambdaConstruct
  readonly lambdas: Map<RouterGroup, LambdaTrpcConstruct>
  readonly authorizersConstruct: AuthorizersConstruct
  readonly apiGw: ApiGwHttpConstruct
  readonly wsConnections: DynamoDbConnectionsConstruct
  readonly wsApi: ApiGwWsConstruct
  readonly wsConnectFn: lambda.Function
  readonly wsDisconnectFn: lambda.Function
  readonly wsDefaultFn: lambda.Function
  readonly wsFanoutFn: lambda.Function
  readonly wsFanoutDlq: cdk.aws_sqs.Queue
}

/**
 * Provision API resources directly on the given scope.
 */
export function buildApiResources(
  scope: Construct,
  envName: string,
  envConfig: EnvConfig,
  vpc: ec2.IVpc,
  dns: DnsConstruct,
  cognito: CognitoConstruct,
  lambdaSg: ec2.ISecurityGroup,
  rdsProxyInstance: rds.DatabaseProxy,
  proxyEndpoint: string,
): ApiOutputs {
  const isProd = envName === 'prod'

  // Authorizers
  const authorizersConstruct = new AuthorizersConstruct(scope, 'Authorizers', {
    envName,
    userPool: cognito.userPool,
    appClientId: cognito.appClient.userPoolClientId,
    region: envConfig.region,
    vpc,
    lambdaSg,
    rdsProxy: rdsProxyInstance,
    proxyEndpoint,
    logRetentionDays: envConfig.logRetentionDays,
  })

  // Single api-lambda for all browser traffic.
  const apiLambda = new ApiLambdaConstruct(scope, 'ApiLambda', {
    envName,
    vpc,
    lambdaSg,
    rdsProxy: rdsProxyInstance,
    proxyEndpoint,
    logRetentionDays: envConfig.logRetentionDays,
    cognitoUserPoolId: cognito.userPool.userPoolId,
    cognitoAppClientId: cognito.appClient.userPoolClientId,
    region: envConfig.region,
    enableProvisionedConcurrency: process.env['ORBITAL_ENABLE_PC'] === '1',
  })

  // Install Lambda — sole survivor of legacy per-router Lambdas.
  const lambdas = new Map<RouterGroup, LambdaTrpcConstruct>()
  const installLambda = new LambdaTrpcConstruct(scope, 'Lambda-tasks', {
    routerGroup: 'tasks',
    envName,
    vpc,
    lambdaSg,
    rdsProxy: rdsProxyInstance,
    secretArns: {},
    proxyEndpoint,
    logRetentionDays: envConfig.logRetentionDays,
    cognitoUserPoolId: cognito.userPool.userPoolId,
    cognitoAppClientId: cognito.appClient.userPoolClientId,
    region: envConfig.region,
  })
  lambdas.set('tasks', installLambda)

  // API Gateway HTTP — use apiLambda.invokeTarget (the `live` alias when
  // PC is enabled, else $LATEST) so Provisioned Concurrency actually
  // serves browser traffic.
  const routeConfigs = [
    { routeKey: 'ANY /trpc/{proxy+}',    fn: apiLambda.invokeTarget, authType: 'none' as const },
    { routeKey: 'ANY /public/{proxy+}',  fn: apiLambda.invokeTarget, authType: 'none' as const },
    { routeKey: 'ANY /install/{proxy+}', fn: installLambda.fn,        authType: 'install' as const },
    // GitHub App webhook — public route, signature-verified inside the Lambda.
    // [Engineer-Principal · Opus · run-orbital-github-integration]
    { routeKey: 'POST /webhooks/github', fn: apiLambda.invokeTarget, authType: 'none' as const },
  ]

  const apiGw = new ApiGwHttpConstruct(scope, 'ApiGw', {
    envName,
    domain: envConfig.domain,
    certificate: dns.certificate,
    hostedZone: dns.hostedZone,
    cognitoAuthorizer: authorizersConstruct.cognitoAuthorizer,
    installAuthorizer: authorizersConstruct.installAuthorizer,
    routes: routeConfigs,
    logRetentionDays: envConfig.logRetentionDays,
  })

  // ------------------------------------------------------------------
  // DynamoDB connections table + WS Lambdas
  // ------------------------------------------------------------------
  const wsConnections = new DynamoDbConnectionsConstruct(scope, 'WsConnections', {
    envName,
  })

  const orchestratorDist = path.resolve(
    __dirname,
    '../../../packages/orchestrator/dist',
  )

  const wsLogRetention = envConfig.logRetentionDays as logs.RetentionDays

  const wsLambdaEnv: Record<string, string> = {
    ORBITAL_DEPLOY_TARGET: 'aws',
    ORBITAL_ENV: envName,
    CONNECTIONS_TABLE: wsConnections.table.tableName,
    AWS_ACCOUNT_ID: cdk.Stack.of(scope).account,
    COGNITO_USER_POOL_ID: cognito.userPool.userPoolId,
    COGNITO_APP_CLIENT_ID: cognito.appClient.userPoolClientId,
  }

  // $connect
  const wsConnectLogGroup = new logs.LogGroup(scope, 'WsConnectLogGroup', {
    logGroupName: `/orbital/${envName}/lambda/ws-connect`,
    retention: wsLogRetention,
    removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
  })

  const wsConnectRole = new iam.Role(scope, 'WsConnectRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description: `Orbital ${envName} WS $connect Lambda execution role`,
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    ],
  })

  const wsConnectFn = new lambda.Function(scope, 'WsConnectFn', {
    functionName: `orbital-${envName}-ws-connect`,
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'lambda/ws/connect.handler',
    code: lambda.Code.fromAsset(orchestratorDist, {
      exclude: ['**/*.test.*', '**/*.spec.*', '**/test/**'],
    }),
    role: wsConnectRole,
    timeout: cdk.Duration.seconds(10),
    memorySize: 256,
    environment: wsLambdaEnv,
    logGroup: wsConnectLogGroup,
    tracing: lambda.Tracing.ACTIVE,
  })
  wsConnections.table.grantWriteData(wsConnectRole)
  wsConnectRole.addToPolicy(new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
    resources: ['*'],
  }))

  // $disconnect
  const wsDisconnectLogGroup = new logs.LogGroup(scope, 'WsDisconnectLogGroup', {
    logGroupName: `/orbital/${envName}/lambda/ws-disconnect`,
    retention: wsLogRetention,
    removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
  })

  const wsDisconnectRole = new iam.Role(scope, 'WsDisconnectRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description: `Orbital ${envName} WS $disconnect Lambda execution role`,
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    ],
  })

  const wsDisconnectFn = new lambda.Function(scope, 'WsDisconnectFn', {
    functionName: `orbital-${envName}-ws-disconnect`,
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'lambda/ws/disconnect.handler',
    code: lambda.Code.fromAsset(orchestratorDist, {
      exclude: ['**/*.test.*', '**/*.spec.*', '**/test/**'],
    }),
    role: wsDisconnectRole,
    timeout: cdk.Duration.seconds(10),
    memorySize: 256,
    environment: wsLambdaEnv,
    logGroup: wsDisconnectLogGroup,
    tracing: lambda.Tracing.ACTIVE,
  })
  wsConnections.table.grantWriteData(wsDisconnectRole)
  wsDisconnectRole.addToPolicy(new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
    resources: ['*'],
  }))

  // $default
  const wsDefaultLogGroup = new logs.LogGroup(scope, 'WsDefaultLogGroup', {
    logGroupName: `/orbital/${envName}/lambda/ws-default`,
    retention: wsLogRetention,
    removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
  })

  const wsDefaultRole = new iam.Role(scope, 'WsDefaultRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description: `Orbital ${envName} WS $default Lambda execution role`,
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    ],
  })
  wsConnections.table.grantReadWriteData(wsDefaultRole)
  wsDefaultRole.addToPolicy(new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
    resources: ['*'],
  }))

  const wsDefaultFn = new lambda.Function(scope, 'WsDefaultFn', {
    functionName: `orbital-${envName}-ws-default`,
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'lambda/ws/default.handler',
    code: lambda.Code.fromAsset(orchestratorDist, {
      exclude: ['**/*.test.*', '**/*.spec.*', '**/test/**'],
    }),
    role: wsDefaultRole,
    timeout: cdk.Duration.seconds(29),
    memorySize: 512,
    environment: wsLambdaEnv,
    logGroup: wsDefaultLogGroup,
    tracing: lambda.Tracing.ACTIVE,
  })

  // WS API (needs to be created before injecting mgmt endpoint into wsDefaultFn)
  const wsApi = new ApiGwWsConstruct(scope, 'WsApi', {
    envName,
    domain: envConfig.domain,
    certificate: dns.certificate,
    hostedZone: dns.hostedZone,
    connectFn: wsConnectFn,
    disconnectFn: wsDisconnectFn,
    defaultFn: wsDefaultFn,
    logRetentionDays: envConfig.logRetentionDays,
  })

  wsDefaultFn.addEnvironment('WS_MGMT_ENDPOINT', wsApi.managementApiEndpoint)
  wsDefaultFn.addEnvironment('WS_API_ID', wsApi.apiId)

  // Fanout Lambda
  const wsFanoutLogGroup = new logs.LogGroup(scope, 'WsFanoutLogGroup', {
    logGroupName: `/orbital/${envName}/lambda/ws-fanout`,
    retention: wsLogRetention,
    removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
  })

  const wsFanoutDlq = new cdk.aws_sqs.Queue(scope, 'WsFanoutDlq', {
    queueName: `orbital-${envName}-ws-fanout-dlq`,
    retentionPeriod: cdk.Duration.days(14),
    encryption: cdk.aws_sqs.QueueEncryption.KMS_MANAGED,
  })

  const wsFanoutRole = new iam.Role(scope, 'WsFanoutRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    description: `Orbital ${envName} WS fanout Lambda execution role`,
    managedPolicies: [
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
    ],
  })
  wsConnections.table.grantReadWriteData(wsFanoutRole)
  wsFanoutRole.addToPolicy(new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['execute-api:ManageConnections'],
    resources: [
      `arn:aws:execute-api:${cdk.Stack.of(scope).region}:${cdk.Stack.of(scope).account}:${wsApi.apiId}/${wsApi.stageName}/*`,
    ],
  }))
  wsFanoutRole.addToPolicy(new iam.PolicyStatement({
    effect: iam.Effect.ALLOW,
    actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
    resources: ['*'],
  }))
  wsFanoutDlq.grantSendMessages(wsFanoutRole)

  const wsFanoutFn = new lambda.Function(scope, 'WsFanoutFn', {
    functionName: `orbital-${envName}-ws-fanout`,
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'lambda/ws/fanout.handler',
    code: lambda.Code.fromAsset(orchestratorDist, {
      exclude: ['**/*.test.*', '**/*.spec.*', '**/test/**'],
    }),
    role: wsFanoutRole,
    timeout: cdk.Duration.seconds(30),
    memorySize: 512,
    environment: {
      ...wsLambdaEnv,
      WS_MGMT_ENDPOINT: wsApi.managementApiEndpoint,
      WS_API_ID: wsApi.apiId,
    },
    logGroup: wsFanoutLogGroup,
    tracing: lambda.Tracing.ACTIVE,
    deadLetterQueue: wsFanoutDlq,
  })

  new cdk.CfnOutput(scope, 'WsFanoutFnArn', {
    value: wsFanoutFn.functionArn,
    description: `Orbital ${envName} WS fanout Lambda ARN (subscribe to SNS in 8-05)`,
    exportName: `OrbitalHub-${envName}-WsFanoutFnArn`,
  })

  return {
    apiLambda,
    lambdas,
    authorizersConstruct,
    apiGw,
    wsConnections,
    wsApi,
    wsConnectFn,
    wsDisconnectFn,
    wsDefaultFn,
    wsFanoutFn,
    wsFanoutDlq,
  }
}
