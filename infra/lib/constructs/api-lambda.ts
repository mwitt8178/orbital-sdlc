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
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as sns from 'aws-cdk-lib/aws-sns'
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
  /**
   * Optional Anthropic API key Secrets Manager ARN. When provided, the
   * Lambda role is granted `secretsmanager:GetSecretValue` on this ARN
   * and `ANTHROPIC_API_KEY_SECRET_ARN` is exposed as an env var so init.ts
   * can hydrate `process.env.ANTHROPIC_API_KEY` on cold start.
   * [Engineer-Principal · Opus · run-vision-llm-decompose]
   */
  readonly anthropicApiKeySecretArn?: string
  /**
   * Optional GitHub App webhook secret Secrets Manager ARN. When provided
   * AND `enableGithubApp` is true, the Lambda role is granted GetSecretValue
   * on this ARN and `ORBITAL_GITHUB_APP_WEBHOOK_SECRET_ARN` is exposed as an
   * env var so the webhook receiver can verify HMAC signatures.
   * [Engineer-Principal · Opus · run-orbital-github-integration]
   */
  readonly githubAppWebhookSecretArn?: string
  /**
   * Optional GitHub App private key Secrets Manager ARN. When provided AND
   * `enableGithubApp` is true, the Lambda role is granted GetSecretValue and
   * `ORBITAL_GITHUB_APP_PRIVATE_KEY_SECRET_ARN` is exposed so app-auth.ts
   * can mint short-lived installation tokens.
   * [Engineer-Principal · Opus · run-orbital-github-integration]
   */
  readonly githubAppPrivateKeySecretArn?: string
  /**
   * Optional GitHub App ID. Exposed as `ORBITAL_GITHUB_APP_ID` env var.
   * Required for installation-token minting; if absent, the orchestrator
   * throws clearly at first call.
   */
  readonly githubAppId?: string
  /**
   * Master switch for GitHub App wiring. When false (or undefined), the
   * githubApp* secrets are ignored entirely and the stack synths cleanly
   * even before the App is registered. Toggle to true ONLY after the App
   * exists and the webhook + private-key secrets have been created.
   * [Engineer-Principal · Opus · run-orbital-github-integration]
   */
  readonly enableGithubApp?: boolean
}

export class ApiLambdaConstruct extends Construct {
  readonly fn: lambda.Function
  readonly role: iam.Role
  readonly logGroup: logs.LogGroup
  readonly liveAlias: lambda.Alias | undefined
  /** Stored for use in addColdPathObservability. */
  private readonly envName: string

  /**
   * The IFunction API Gateway integrations should target. When Provisioned
   * Concurrency is enabled this is the `live` alias (so warm containers
   * actually serve traffic); otherwise it's the unqualified function ($LATEST).
   * Callers MUST use this rather than `fn` directly when wiring API GW.
   */
  readonly invokeTarget: lambda.IFunction

  constructor(scope: Construct, id: string, props: ApiLambdaProps) {
    super(scope, id)
    this.envName = props.envName

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
      // CRITICAL: NODE_ENV=production prevents pino logger from initializing
      // pino-pretty transport (which is externalized and not in the bundle).
      // Other libraries (drizzle, react-query for SSR, etc.) also branch on this.
      NODE_ENV: 'production',
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
      ...(props.anthropicApiKeySecretArn
        ? { ANTHROPIC_API_KEY_SECRET_ARN: props.anthropicApiKeySecretArn }
        : {}),
      // GitHub App integration — gated by enableGithubApp so the stack synths
      // cleanly when the App hasn't been registered yet.
      // [Engineer-Principal · Opus · run-orbital-github-integration]
      ...(props.enableGithubApp === true
        ? {
            ORBITAL_GITHUB_APP_ENABLED: '1',
            ...(props.githubAppId ? { ORBITAL_GITHUB_APP_ID: props.githubAppId } : {}),
            ...(props.githubAppWebhookSecretArn
              ? { ORBITAL_GITHUB_APP_WEBHOOK_SECRET_ARN: props.githubAppWebhookSecretArn }
              : {}),
            ...(props.githubAppPrivateKeySecretArn
              ? {
                  ORBITAL_GITHUB_APP_PRIVATE_KEY_SECRET_ARN:
                    props.githubAppPrivateKeySecretArn,
                }
              : {}),
          }
        : {}),
    }

    // Vision LLM-decompose: grant GetSecretValue on the Anthropic key secret.
    // [Engineer-Principal · Opus · run-vision-llm-decompose]
    if (props.anthropicApiKeySecretArn) {
      this.role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['secretsmanager:GetSecretValue'],
          resources: [props.anthropicApiKeySecretArn],
        }),
      )
    }

    // GitHub App: grant GetSecretValue on the webhook secret + private-key
    // secret. Gated by enableGithubApp so the stack synths cleanly when the
    // secrets don't exist yet (placeholder ARNs would otherwise break IAM
    // policy validation at deploy time, not synth — but we keep the gate
    // for clarity).
    // [Engineer-Principal · Opus · run-orbital-github-integration]
    if (props.enableGithubApp === true) {
      const githubAppArns: string[] = []
      if (props.githubAppWebhookSecretArn) githubAppArns.push(props.githubAppWebhookSecretArn)
      if (props.githubAppPrivateKeySecretArn) githubAppArns.push(props.githubAppPrivateKeySecretArn)
      if (githubAppArns.length > 0) {
        this.role.addToPolicy(
          new iam.PolicyStatement({
            effect: iam.Effect.ALLOW,
            actions: ['secretsmanager:GetSecretValue'],
            resources: githubAppArns,
          }),
        )
      }
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
      // Route API Gateway traffic through the alias so PC=2 instances
      // actually serve requests. Without this, PC is provisioned but
      // every request still hits a cold container at $LATEST.
      this.invokeTarget = this.liveAlias
    } else {
      this.liveAlias = undefined
      this.invokeTarget = this.fn
    }
    // Suppress the "unused" warning when PC is off; the field is part of
    // the public contract.
    void this.invokeTarget

    new cdk.CfnOutput(this, 'FunctionArn', {
      value: this.fn.functionArn,
      description: `Orbital ${props.envName} api-lambda ARN`,
      exportName: `OrbitalHub-${props.envName}-ApiLambdaArn`,
    })

    cdk.Tags.of(this).add('orbital:component', 'api-lambda')
  }

  /**
   * Wire cold-path observability: metric filters on the api-lambda log group,
   * an IAM-auth-failure alarm, and a focused CloudWatch dashboard.
   *
   * Call this AFTER the ObservabilityConstruct is created so the alarm SNS
   * topic already exists. If no topic is provided, a dedicated topic
   * `orbital-<envName>-api-alerts` is created.
   *
   * Metric filters:
   *   - `{ $.event = "iam_auth_failed" }` → Orbital/ApiLambda/IamAuthFailures
   *   - `{ $.event = "lambda_init" && $.coldStart IS TRUE }` → Orbital/ApiLambda/ColdStarts
   *
   * Alarm:
   *   - IamAuthFailures >= 1 in 5 min (1 evaluation period, treat missing as not breaching)
   *
   * Dashboard `orbital-<envName>-api`:
   *   - Cold-start count (sum, 5-min)
   *   - IAM auth failures (sum, 5-min)
   *   - Lambda invocations / errors / duration p50+p99 on invokeTarget
   *   - Provisioned concurrency utilisation (when PC is enabled)
   */
  addColdPathObservability(alarmTopic?: sns.ITopic): cloudwatch.Dashboard {
    const envFromLogGroup = this.envName

    const resolvedAlarmTopic =
      alarmTopic ??
      new sns.Topic(this, 'ApiAlertTopic', {
        topicName: `orbital-${envFromLogGroup}-api-alerts`,
        displayName: `Orbital ${envFromLogGroup} api-lambda cold-path alerts`,
      })

    // ------------------------------------------------------------------
    // Metric filter 1: IAM auth failures
    // ------------------------------------------------------------------
    const iamAuthFilter = new logs.MetricFilter(this, 'IamAuthFailedFilter', {
      logGroup: this.logGroup,
      filterPattern: logs.FilterPattern.stringValue('$.event', '=', 'iam_auth_failed'),
      metricNamespace: 'Orbital/ApiLambda',
      metricName: 'IamAuthFailures',
      metricValue: '1',
      defaultValue: 0,
      unit: cloudwatch.Unit.COUNT,
    })

    const iamAuthFailureMetric = iamAuthFilter.metric({
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
      label: 'IAM Auth Failures',
    })

    // ------------------------------------------------------------------
    // Metric filter 2: cold starts (lambda_init with coldStart = true)
    // CloudWatch filter pattern booleans use the IS TRUE syntax
    // ------------------------------------------------------------------
    const coldStartFilter = new logs.MetricFilter(this, 'ColdStartFilter', {
      logGroup: this.logGroup,
      filterPattern: logs.FilterPattern.all(
        logs.FilterPattern.stringValue('$.event', '=', 'lambda_init'),
        logs.FilterPattern.booleanValue('$.coldStart', true),
      ),
      metricNamespace: 'Orbital/ApiLambda',
      metricName: 'ColdStarts',
      metricValue: '1',
      defaultValue: 0,
      unit: cloudwatch.Unit.COUNT,
    })

    const coldStartMetric = coldStartFilter.metric({
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
      label: 'Cold Starts',
    })

    // ------------------------------------------------------------------
    // Alarm: any IAM auth failure in 5 min fires immediately
    // ------------------------------------------------------------------
    const iamAuthAlarm = new cloudwatch.Alarm(this, 'IamAuthFailedAlarm', {
      alarmName: `orbital-${envFromLogGroup}-api-iam-auth-failed`,
      alarmDescription:
        'api-lambda emitted iam_auth_failed — RDS Proxy IAM token expired or auth broken. ' +
        'Check /orbital/' + envFromLogGroup + '/lambda/api log group.',
      metric: iamAuthFailureMetric,
      threshold: 1,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })
    iamAuthAlarm.addAlarmAction(new cloudwatchActions.SnsAction(resolvedAlarmTopic))

    // ------------------------------------------------------------------
    // Dashboard: orbital-<envName>-api
    // ------------------------------------------------------------------
    const dashboard = new cloudwatch.Dashboard(this, 'ApiColdPathDashboard', {
      dashboardName: `orbital-${envFromLogGroup}-api`,
    })

    // Standard Lambda metrics on the invokeTarget (live alias when PC enabled)
    const targetDimensions: cloudwatch.DimensionHash = this.liveAlias
      ? { FunctionName: this.fn.functionName, Resource: this.liveAlias.aliasName }
      : { FunctionName: this.fn.functionName }

    const invocations = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Invocations',
      dimensionsMap: targetDimensions,
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
      label: 'Invocations',
    })
    const errors = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Errors',
      dimensionsMap: targetDimensions,
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
      label: 'Errors',
      color: '#D13212',
    })
    const durationP50 = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Duration',
      dimensionsMap: targetDimensions,
      period: cdk.Duration.minutes(5),
      statistic: 'p50',
      label: 'Duration p50 (ms)',
    })
    const durationP99 = new cloudwatch.Metric({
      namespace: 'AWS/Lambda',
      metricName: 'Duration',
      dimensionsMap: targetDimensions,
      period: cdk.Duration.minutes(5),
      statistic: 'p99',
      label: 'Duration p99 (ms)',
      color: '#D13212',
    })

    // Row 1: cold-start count + IAM failures
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## Cold-Path Observability — orbital-${envFromLogGroup}-api`,
        width: 24,
        height: 1,
      }),
    )
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Cold Starts (5-min sum)',
        width: 8,
        height: 6,
        left: [coldStartMetric],
        view: cloudwatch.GraphWidgetView.BAR,
      }),
      new cloudwatch.GraphWidget({
        title: 'IAM Auth Failures (5-min sum)',
        width: 8,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'Orbital/ApiLambda',
            metricName: 'IamAuthFailures',
            period: cdk.Duration.minutes(5),
            statistic: 'Sum',
            label: 'IAM Auth Failures',
            color: '#D13212',
          }),
        ],
        view: cloudwatch.GraphWidgetView.BAR,
      }),
      new cloudwatch.AlarmWidget({
        title: 'IamAuthFailed Alarm Status',
        alarm: iamAuthAlarm,
        width: 8,
        height: 6,
      }),
    )

    // Row 2: Lambda invocations / errors / duration p50 p99
    dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '## Lambda Invocations & Errors',
        width: 24,
        height: 1,
      }),
    )
    dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Invocations vs Errors',
        width: 12,
        height: 6,
        left: [invocations],
        right: [errors],
      }),
      new cloudwatch.GraphWidget({
        title: 'Duration p50 / p99',
        width: 12,
        height: 6,
        left: [durationP50, durationP99],
      }),
    )

    // Row 3: Provisioned Concurrency utilisation (only meaningful when PC enabled)
    if (this.liveAlias) {
      dashboard.addWidgets(
        new cloudwatch.TextWidget({
          markdown: '## Provisioned Concurrency',
          width: 24,
          height: 1,
        }),
      )
      dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: 'Provisioned Concurrency Utilization (%)',
          width: 12,
          height: 6,
          left: [
            new cloudwatch.Metric({
              namespace: 'AWS/Lambda',
              metricName: 'ProvisionedConcurrencyUtilization',
              dimensionsMap: targetDimensions,
              period: cdk.Duration.minutes(1),
              statistic: 'Maximum',
              label: 'PC Utilization %',
            }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: 'Provisioned Concurrency Spill-overs',
          width: 12,
          height: 6,
          left: [
            new cloudwatch.Metric({
              namespace: 'AWS/Lambda',
              metricName: 'ProvisionedConcurrencySpilloverInvocations',
              dimensionsMap: targetDimensions,
              period: cdk.Duration.minutes(1),
              statistic: 'Sum',
              label: 'Spill-overs (cold starts despite PC)',
              color: '#FF9900',
            }),
          ],
        }),
      )
    }

    new cdk.CfnOutput(this, 'ColdPathDashboardName', {
      value: dashboard.dashboardName,
      description: `Orbital ${envFromLogGroup} api-lambda cold-path dashboard`,
      exportName: `OrbitalHub-${envFromLogGroup}-ApiColdPathDashboardName`,
    })

    new cdk.CfnOutput(this, 'IamAuthAlarmArn', {
      value: iamAuthAlarm.alarmArn,
      description: `Orbital ${envFromLogGroup} api-lambda IAM auth failure alarm ARN`,
      exportName: `OrbitalHub-${envFromLogGroup}-IamAuthAlarmArn`,
    })

    return dashboard
  }
}
