/**
 * api-lambda.ts — Single-bundle Lambda for the Orbital browser tRPC surface.
 *
 * Replaces the per-router-group `LambdaTrpcConstruct` factory used in
 * round 8-03. Phase 1 of the migration consolidates 12 Lambdas into 1
 * because the previous design provisioned them but only used one
 * (`trpc-all`).
 *
 * Bundle:
 *   - Source: `packages/api-lambda/dist/handler.mjs` (esbuild output)
 *   - Runtime: nodejs22.x
 *   - Memory: 1024 MB
 *   - Timeout: 29s (under API GW 30s limit)
 *   - VPC-attached for RDS Proxy access
 *
 * Auth:
 *   - The Lambda itself is auth-agnostic. API Gateway routes attach
 *     Cognito JWT authorizer for `/trpc/{proxy+}` and no authorizer for
 *     `/public/{proxy+}`. Both routes target this same Lambda.
 *
 * Provisioned Concurrency:
 *   - Off by first deploy. Enabled by setting ORBITAL_ENABLE_PC=1 in the
 *     CDK app environment (see Phase 1.11).
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as path from 'path'
import { Construct } from 'constructs'

export interface ApiLambdaProps {
  readonly envName: string
  readonly vpc: ec2.IVpc
  readonly lambdaSg: ec2.ISecurityGroup
  readonly rdsProxy: rds.DatabaseProxy
  readonly proxyEndpoint: string
  readonly logRetentionDays: number
  readonly cognitoUserPoolId: string
  readonly cognitoAppClientId: string
  readonly region: string
  /**
   * If true, configure provisioned concurrency = 2 on the `live` alias.
   * Caller must wait until first deploy is healthy before flipping this.
   */
  readonly enableProvisionedConcurrency?: boolean
}

export class ApiLambdaConstruct extends Construct {
  readonly fn: lambda.Function
  readonly role: iam.Role
  readonly logGroup: logs.LogGroup
  readonly liveAlias: lambda.Alias | undefined

  constructor(scope: Construct, id: string, props: ApiLambdaProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'

    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/orbital/${props.envName}/lambda/api`,
      retention: props.logRetentionDays as logs.RetentionDays,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Orbital ${props.envName} api-lambda execution role (browser tRPC surface)`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole',
        ),
      ],
    })

    // RDS IAM auth — Lambda generates short-lived tokens.
    props.rdsProxy.grantConnect(this.role, 'orbital_admin')

    // X-Ray write
    this.role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
        resources: ['*'],
      }),
    )

    // Code path: the api-lambda dist directory.
    // From infra/lib/constructs/ go up 3 levels (constructs → lib → infra → repo root)
    // then into packages/api-lambda/dist.
    const apiLambdaDist = path.resolve(__dirname, '../../../packages/api-lambda/dist')

    const environment: Record<string, string> = {
      ORBITAL_DEPLOY_TARGET: 'aws',
      ORBITAL_TENANT_RESOLUTION: 'jwt',
      ORBITAL_HOME: '/tmp/.orbital',
      RDS_PROXY_HOSTNAME: props.proxyEndpoint,
      RDS_PROXY_PORT: '5432',
      AURORA_DB_NAME: 'orbital_hub',
      AURORA_USERNAME: 'orbital_admin',
      AWS_ACCOUNT_ID: cdk.Stack.of(this).account,
      COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
      COGNITO_APP_CLIENT_ID: props.cognitoAppClientId,
      ORBITAL_ENV: props.envName,
      // No NODE_ENV — the orchestrator's loadEnv schema accepts the default.
    }

    this.fn = new lambda.Function(this, 'Fn', {
      functionName: `orbital-${props.envName}-api`,
      runtime: lambda.Runtime.NODEJS_22_X,
      // The bundled file is dist/handler.mjs and the export is `handler`.
      // Node ESM Lambda runtime: handler path is `<filename-without-ext>.<exportName>`.
      handler: 'handler.handler',
      code: lambda.Code.fromAsset(apiLambdaDist, {
        // Sourcemap helpful in CloudWatch but adds ~5 MB; keep it.
        exclude: ['**/*.test.*', '**/*.spec.*', 'metafile.json'],
      }),
      role: this.role,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      timeout: cdk.Duration.seconds(29),
      memorySize: 1024,
      environment,
      logGroup: this.logGroup,
      tracing: lambda.Tracing.ACTIVE,
      currentVersionOptions: {
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        retryAttempts: 1,
      },
    })

    // Provisioned Concurrency on a `live` alias — only when explicitly opted in.
    if (props.enableProvisionedConcurrency === true) {
      const version = this.fn.currentVersion
      this.liveAlias = new lambda.Alias(this, 'LiveAlias', {
        aliasName: 'live',
        version,
        provisionedConcurrentExecutions: 2,
        description: `Orbital ${props.envName} api-lambda — provisioned concurrency=2`,
      })
    } else {
      this.liveAlias = undefined
    }

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: this.fn.functionArn,
      description: `Orbital ${props.envName} api-lambda ARN`,
      exportName: `OrbitalHub-${props.envName}-ApiLambdaArn`,
    })

    cdk.Tags.of(this).add('orbital:component', 'api-lambda')
  }
}
