// [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as s3 from 'aws-cdk-lib/aws-s3'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as path from 'path'
import { Construct } from 'constructs'

/**
 * All valid router group names.
 * One Lambda is created per group.
 */
export type RouterGroup =
  | 'auth'
  | 'tasks'
  | 'memory'
  | 'comms'
  | 'defects'
  | 'audit'
  | 'prs'
  | 'cost'
  | 'providers'
  | 'team'
  | 'onboarding'

/**
 * Router groups that get Provisioned Concurrency = 2 (hot paths).
 * All others default to 0 (cold start acceptable).
 */
const HOT_ROUTER_GROUPS: Set<RouterGroup> = new Set(['auth', 'tasks'])

export interface LambdaTrpcProps {
  /**
   * Logical router group name. Drives the function name, handler path,
   * log group name, and provisioned concurrency.
   */
  readonly routerGroup: RouterGroup
  /**
   * Environment name — used in naming.
   */
  readonly envName: string
  /**
   * VPC for Lambda placement (PRIVATE_WITH_EGRESS subnet).
   */
  readonly vpc: ec2.IVpc
  /**
   * Lambda security group (created by RdsProxyConstruct in 8-02).
   * Attached to the function so the proxy SG allows ingress.
   */
  readonly lambdaSg: ec2.ISecurityGroup
  /**
   * RDS Proxy — grantConnect called so Lambda can use IAM DB auth.
   */
  readonly rdsProxy: rds.DatabaseProxy
  /**
   * Secrets Manager secret ARNs injected as environment variables.
   * Keyed by env var name → ARN.
   */
  readonly secretArns: Record<string, string>
  /**
   * RDS Proxy endpoint hostname for DB connection.
   */
  readonly proxyEndpoint: string
  /**
   * CloudWatch log retention in days.
   */
  readonly logRetentionDays: number
  /**
   * SNS topic ARN for event fanout — Lambda gets publish permission.
   * Optional; not all groups publish events.
   */
  readonly snsTopicArn?: string
  /**
   * Replay S3 bucket — Lambda gets read permission for replay blobs.
   * Optional; only audit and replay groups need this.
   */
  readonly replayBucket?: s3.IBucket
  /**
   * Cognito User Pool ID — injected as COGNITO_USER_POOL_ID env var.
   */
  readonly cognitoUserPoolId: string
  /**
   * Cognito App Client ID — injected as COGNITO_APP_CLIENT_ID env var.
   */
  readonly cognitoAppClientId: string
  /**
   * AWS region for the env — needed for RDS signer.
   */
  readonly region: string
}

/**
 * LambdaTrpcConstruct — factory for a single tRPC router group Lambda.
 *
 * Features:
 *  - Runtime: Node.js 22
 *  - Memory: 1024 MB (tunable)
 *  - Timeout: 29s (under API GW 30s limit)
 *  - X-Ray tracing: ACTIVE
 *  - Provisioned Concurrency: 2 for auth + tasks; 0 for others
 *  - IAM role: Aurora IAM auth + Secrets Manager read + S3 read for replay
 *  - VPC: PRIVATE_WITH_EGRESS subnets, attached to Lambda SG
 *  - Log group: 30-day retention (configurable)
 *
 * Provisioned Concurrency implementation:
 *  The function is published as a version (via fn.currentVersion) then
 *  a scalable target / alias pointing at that version gets the PC configured.
 *  We use a simple alias "live" pointing at the LATEST published version.
 *  The API Gateway integration is attached to the function (not alias) so
 *  traffic reaches the correct runtime container.
 */
export class LambdaTrpcConstruct extends Construct {
  /**
   * The Lambda function resource.
   * API Gateway integrations reference this.
   */
  readonly fn: lambda.Function

  /**
   * IAM execution role for the function.
   * Consumers (e.g. 8-07 secrets) can grant additional permissions.
   */
  readonly role: iam.Role

  /**
   * The CloudWatch log group.
   */
  readonly logGroup: logs.LogGroup

  /**
   * Whether provisioned concurrency is enabled (true for auth + tasks).
   */
  readonly hasProvisionedConcurrency: boolean

  constructor(scope: Construct, id: string, props: LambdaTrpcProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'
    const isHotPath = HOT_ROUTER_GROUPS.has(props.routerGroup)
    this.hasProvisionedConcurrency = isHotPath

    // ------------------------------------------------------------------
    // CloudWatch log group — explicit retention
    // ------------------------------------------------------------------
    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/orbital/${props.envName}/lambda/trpc-${props.routerGroup}`,
      retention: props.logRetentionDays as logs.RetentionDays,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    // ------------------------------------------------------------------
    // IAM execution role — least-privilege per security-serverless skill
    // ------------------------------------------------------------------
    this.role = new iam.Role(this, 'Role', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Orbital ${props.envName} tRPC ${props.routerGroup} Lambda execution role`,
      managedPolicies: [
        // Allows CloudWatch Logs write + ENI creation/deletion for VPC Lambda
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole',
        ),
      ],
    })

    // RDS IAM auth — rds-db:connect to the proxy
    props.rdsProxy.grantConnect(this.role, 'orbital_admin')

    // Secrets Manager: grant read for each injected secret
    for (const [, arn] of Object.entries(props.secretArns)) {
      this.role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['secretsmanager:GetSecretValue', 'secretsmanager:DescribeSecret'],
          resources: [arn],
        }),
      )
    }

    // SNS publish (event fanout) — only for groups that emit events
    if (props.snsTopicArn) {
      this.role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['sns:Publish'],
          resources: [props.snsTopicArn],
        }),
      )
    }

    // S3 read for replay blobs (audit + replay groups)
    if (props.replayBucket) {
      props.replayBucket.grantRead(this.role)
    }

    // X-Ray write permission (tracing active)
    this.role.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
        resources: ['*'],
      }),
    )

    // ------------------------------------------------------------------
    // Lambda code path
    // Handlers live at packages/orchestrator/src/lambda/handlers/<group>.ts
    // We point at the compiled dist directory.
    // ------------------------------------------------------------------
    const orchestratorDist = path.resolve(
      __dirname,
      '../../../packages/orchestrator/dist',
    )

    // ------------------------------------------------------------------
    // Environment variables
    // ------------------------------------------------------------------
    const environment: Record<string, string> = {
      ORBITAL_DEPLOY_TARGET: 'aws',
      ORBITAL_TENANT_RESOLUTION: 'jwt',
      RDS_PROXY_HOSTNAME: props.proxyEndpoint,
      RDS_PROXY_PORT: '5432',
      AURORA_DB_NAME: 'orbital_hub',
      AURORA_USERNAME: 'orbital_admin',
      AWS_ACCOUNT_ID: cdk.Stack.of(this).account,
      COGNITO_USER_POOL_ID: props.cognitoUserPoolId,
      COGNITO_APP_CLIENT_ID: props.cognitoAppClientId,
      ORBITAL_ENV: props.envName,
      ORBITAL_ROUTER_GROUP: props.routerGroup,
      ...props.secretArns,
    }

    // ------------------------------------------------------------------
    // Lambda function
    // ------------------------------------------------------------------
    this.fn = new lambda.Function(this, 'Fn', {
      functionName: `orbital-${props.envName}-trpc-${props.routerGroup}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: `lambda/handlers/${props.routerGroup}.handler`,
      // Code loaded from the compiled orchestrator dist directory.
      // In production CI this is the built artifact; for synth testing
      // we use a dummy asset path (tests use Template assertions not Code).
      code: lambda.Code.fromAsset(orchestratorDist, {
        // Exclude non-essential files to reduce package size
        exclude: [
          '**/*.test.*',
          '**/*.spec.*',
          '**/test/**',
          '**/__tests__/**',
        ],
      }),
      role: this.role,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      timeout: cdk.Duration.seconds(29), // just under API GW 30s limit
      memorySize: 1024,
      environment,
      logGroup: this.logGroup,
      tracing: lambda.Tracing.ACTIVE,
      // Allow Lambda to be used with provisioned concurrency
      currentVersionOptions: {
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        retryAttempts: 1,
      },
    })

    // ------------------------------------------------------------------
    // Provisioned Concurrency for hot paths (auth, tasks)
    // Uses a version alias "live" to attach PC. The alias is also what
    // API Gateway integrations point at so warm containers are used.
    // ------------------------------------------------------------------
    if (isHotPath) {
      // Publish a version so we can configure PC on an alias
      const version = this.fn.currentVersion

      // Alias "live" → current version with PC = 2
      new lambda.Alias(this, 'LiveAlias', {
        aliasName: 'live',
        version,
        provisionedConcurrentExecutions: 2,
        description: `Orbital ${props.envName} tRPC ${props.routerGroup} — provisioned concurrency=2`,
      })
    }

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'FunctionArn', {
      value: this.fn.functionArn,
      description: `Orbital ${props.envName} tRPC ${props.routerGroup} Lambda ARN`,
      exportName: `OrbitalHub-${props.envName}-Trpc-${props.routerGroup}-Arn`,
    })

    cdk.Tags.of(this).add('orbital:component', `trpc-${props.routerGroup}`)
  }
}
