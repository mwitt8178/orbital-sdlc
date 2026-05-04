import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import { Construct } from 'constructs'
import { CognitoConstruct } from './constructs/cognito'
import { DnsConstruct } from './constructs/dns'
import { AuroraConstruct } from './constructs/aurora'
import { RdsProxyConstruct } from './constructs/rds-proxy'
import { StaticUiConstruct } from './constructs/static-ui'
import { ReplayBucketConstruct } from './constructs/replay-bucket'
import { LambdaTrpcConstruct, RouterGroup } from './constructs/lambda-trpc'
import { ApiLambdaConstruct } from './constructs/api-lambda'
import { ApiGwHttpConstruct } from './constructs/api-gw-http'
import { AuthorizersConstruct } from './constructs/authorizers'
import { SecretsConstruct, SecretRef, secretName } from './constructs/secrets'
import { PerTenantKmsConstruct } from './constructs/per-tenant-kms'
import { KeyRotationLambdaConstruct } from './constructs/key-rotation-lambda'
import { ApiGwWsConstruct } from './constructs/api-gw-ws'
import { DynamoDbConnectionsConstruct } from './constructs/dynamodb-connections'
import { EventBusConstruct } from './constructs/event-bus'
import { ObservabilityConstruct, type LambdaDescriptor, type SqsQueueDescriptor } from './constructs/observability'
import { WafConstruct } from './constructs/waf'

// Phase 4 stack split — composition-root delegators
import { buildNetworkResources } from './stacks/network-stack'
import { buildDataResources } from './stacks/data-stack'
import { buildAuthResources } from './stacks/auth-stack'
import { buildApiResources } from './stacks/api-stack'
import { buildDaemonResources } from './stacks/daemon-stack'
import { buildEventsResources } from './stacks/events-stack'
import { buildWebResources } from './stacks/web-stack'
import { secretEnvVarName, secretNameEnvVar, secretArnFor } from './stacks/secret-helpers'

/**
 * Per-environment configuration - loaded from cdk.json context key "envs".
 */
export interface EnvConfig {
  readonly account: string
  readonly region: string
  readonly domain: string
  readonly auroraMinAcu: number
  readonly auroraMaxAcu: number
  readonly logRetentionDays: number
  readonly enableMfa: boolean
  /**
   * When false, Route 53 hosted zone and ACM certificate are NOT created.
   * All DNS-dependent resources (custom domains, Route 53 records) are skipped.
   * AWS-generated URLs are used instead:
   *   - CloudFront: *.cloudfront.net
   *   - HTTP API:   https://<api-id>.execute-api.<region>.amazonaws.com
   *   - WS API:     wss://<api-id>.execute-api.<region>.amazonaws.com/$default/
   *   - Cognito:    orbital-<envName>.auth.<region>.amazoncognito.com
   * Default: true (prod and rreed use custom DNS).
   * Omitting this field is treated as true (backwards compatible).
   */
  readonly useCustomDomain?: boolean
  /**
   * Optional shared Anthropic API key secret ARN. When set, the api-lambda
   * gets `secretsmanager:GetSecretValue` on this ARN and ANTHROPIC_API_KEY_SECRET_ARN
   * is exposed as an env var so init.ts can hydrate process.env.ANTHROPIC_API_KEY.
   * [Engineer-Principal · Opus · run-vision-llm-decompose]
   */
  readonly anthropicApiKeySecretArn?: string
}

export interface OrbitalHubStackProps extends cdk.StackProps {
  readonly envName: 'mwitt' | 'rreed' | 'prod'
  readonly envConfig: EnvConfig
}

/**
 * OrbitalHubStack — composition root for all Orbital Hub resources.
 *
 * Phase 4 stack split: the constructor delegates to 7 build functions in
 * infra/lib/stacks/. Each function instantiates its constructs directly on
 * `this` (the stack), preserving every CDK logical ID bit-for-bit so
 * CloudFormation sees zero resource changes on cdk diff.
 *
 * Dependency order (mirrors original monolith construction order):
 *   network → data (includes StaticUi to preserve CDK singleton ordering)
 *   → auth → api → events → daemon → observability (inline) → web
 */
export class OrbitalHubStack extends cdk.Stack {
  readonly vpc: ec2.IVpc
  readonly cognito: CognitoConstruct
  readonly dns: DnsConstruct
  readonly aurora: AuroraConstruct
  readonly rdsProxy: RdsProxyConstruct
  readonly staticUi: StaticUiConstruct
  readonly replayBucket: ReplayBucketConstruct
  readonly lambdas: Map<RouterGroup, LambdaTrpcConstruct>
  readonly apiLambda: ApiLambdaConstruct
  readonly authorizersConstruct: AuthorizersConstruct
  readonly apiGw: ApiGwHttpConstruct
  readonly secrets: SecretsConstruct
  readonly perTenantKms: PerTenantKmsConstruct
  readonly keyRotation: KeyRotationLambdaConstruct
  readonly wsConnections: DynamoDbConnectionsConstruct
  readonly wsApi: ApiGwWsConstruct
  readonly eventBus: EventBusConstruct
  readonly observability: ObservabilityConstruct
  readonly waf: WafConstruct

  constructor(scope: Construct, id: string, props: OrbitalHubStackProps) {
    super(scope, id, {
      ...props,
      env: {
        account:
          props.envConfig.account === '<TBD>'
            ? process.env['CDK_DEFAULT_ACCOUNT']
            : props.envConfig.account,
        region: props.envConfig.region,
      },
      description: `Orbital Hub - ${props.envName} environment (8-01: VPC + Cognito + DNS)`,
      terminationProtection: props.envName === 'prod',
    })

    // ------------------------------------------------------------------
    // 4.1 Network — VPC + DNS/ACM
    // ------------------------------------------------------------------
    const network = buildNetworkResources(this, props.envName, props.envConfig)
    this.vpc = network.vpc
    this.dns = network.dns

    // ------------------------------------------------------------------
    // 4.2 Data — Aurora + RDS Proxy + StaticUi + S3 replay
    // StaticUiConstruct is intentionally created here (before ReplayBucket)
    // to preserve CDK singleton provider description ordering.
    // ------------------------------------------------------------------
    const data = buildDataResources(
      this,
      props.envName,
      props.envConfig,
      this.vpc,
      this.dns.certificate,
      this.dns.hostedZone,
    )
    this.aurora = data.aurora
    this.rdsProxy = data.rdsProxy
    this.staticUi = data.staticUi
    this.replayBucket = data.replayBucket

    // ------------------------------------------------------------------
    // 4.3 Auth — Cognito + Secrets + KMS + key rotation
    // ------------------------------------------------------------------
    const auth = buildAuthResources(
      this,
      props.envName,
      props.envConfig,
      this.aurora.masterSecret,
      this.dns.hostedZone,
    )
    this.cognito = auth.cognito
    this.secrets = auth.secrets
    this.perTenantKms = auth.perTenantKms
    this.keyRotation = auth.keyRotation

    // ------------------------------------------------------------------
    // 4.4 API — API GW HTTP/WS, api-lambda, install-lambda, ws-* lambdas
    // ------------------------------------------------------------------
    const api = buildApiResources(
      this,
      props.envName,
      props.envConfig,
      this.vpc,
      this.dns,
      this.cognito,
      this.rdsProxy.lambdaSecurityGroup,
      this.rdsProxy.proxy,
      this.rdsProxy.proxy.endpoint,
    )
    this.apiLambda = api.apiLambda
    this.lambdas = api.lambdas
    this.authorizersConstruct = api.authorizersConstruct
    this.apiGw = api.apiGw
    this.wsConnections = api.wsConnections
    this.wsApi = api.wsApi

    // Replay bucket grant — api-lambda serves audit procedures that read blobs.
    this.replayBucket.bucket.grantRead(this.apiLambda.role)

    // Secrets + KMS grants for api-lambda
    const apiLambdaSecretRefs: SecretRef[] = ['dbMasterCreds', 'hubMasterKey', 'githubWebhookSecret']
    this.secrets.grantReadFor(this.apiLambda.role, apiLambdaSecretRefs)
    for (const ref of apiLambdaSecretRefs) {
      this.apiLambda.fn.addEnvironment(secretEnvVarName(ref), secretArnFor(this.secrets, ref))
      this.apiLambda.fn.addEnvironment(secretNameEnvVar(ref), secretName(props.envName, ref))
    }

    // Secrets + KMS grants for install-lambda
    const installLambdaConstruct = this.lambdas.get('tasks')!
    const installSecretRefs: SecretRef[] = ['dbMasterCreds', 'hubMasterKey']
    this.secrets.grantReadFor(installLambdaConstruct.role, installSecretRefs)
    for (const ref of installSecretRefs) {
      installLambdaConstruct.fn.addEnvironment(secretEnvVarName(ref), secretArnFor(this.secrets, ref))
      installLambdaConstruct.fn.addEnvironment(secretNameEnvVar(ref), secretName(props.envName, ref))
    }

    this.perTenantKms.grantPerTenantUsage(this.apiLambda.role)
    this.perTenantKms.grantOnboardingPermissions(this.apiLambda.role)
    this.perTenantKms.grantTenantDeletion(this.apiLambda.role)

    // Vision LLM-decompose: grant the api-lambda read access to the shared
    // Anthropic API key secret and expose its ARN as an env var so init.ts
    // can populate process.env.ANTHROPIC_API_KEY on cold start.
    // This secret is cross-environment shared (prometheus/mwitt/global),
    // managed outside this stack — we only grant read.
    // [Engineer-Principal · Opus · run-vision-llm-decompose]
    const anthropicSecretArn = props.envConfig.anthropicApiKeySecretArn
    if (anthropicSecretArn) {
      this.apiLambda.role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['secretsmanager:GetSecretValue'],
          resources: [anthropicSecretArn],
        }),
      )
      this.apiLambda.fn.addEnvironment('ANTHROPIC_API_KEY_SECRET_ARN', anthropicSecretArn)
    }

    // GitHub App integration — gated by ORBITAL_GITHUB_APP_ENABLED env flag
    // at synth time. The placeholder ARNs are well-formed so IAM policies
    // synth cleanly; deploy-time access is only attempted when the orchestrator
    // actually calls Secrets Manager (which the gating env var prevents until
    // the App is registered).
    // [Engineer-Principal · Opus · run-orbital-github-integration]
    if (process.env['ORBITAL_GITHUB_APP_ENABLED'] === '1') {
      const ghWebhookArn =
        process.env['ORBITAL_GITHUB_APP_WEBHOOK_SECRET_ARN'] ??
        `arn:aws:secretsmanager:${props.envConfig.region}:${cdk.Stack.of(this).account}:secret:orbital-${props.envName}/github-app-webhook-secret-*`
      const ghPrivateKeyArn =
        process.env['ORBITAL_GITHUB_APP_PRIVATE_KEY_SECRET_ARN'] ??
        `arn:aws:secretsmanager:${props.envConfig.region}:${cdk.Stack.of(this).account}:secret:orbital-${props.envName}/github-app-private-key-*`

      this.apiLambda.role.addToPolicy(
        new iam.PolicyStatement({
          effect: iam.Effect.ALLOW,
          actions: ['secretsmanager:GetSecretValue'],
          resources: [ghWebhookArn, ghPrivateKeyArn],
        }),
      )
      this.apiLambda.fn.addEnvironment('ORBITAL_GITHUB_APP_ENABLED', '1')
      this.apiLambda.fn.addEnvironment('ORBITAL_GITHUB_APP_WEBHOOK_SECRET_ARN', ghWebhookArn)
      this.apiLambda.fn.addEnvironment(
        'ORBITAL_GITHUB_APP_PRIVATE_KEY_SECRET_ARN',
        ghPrivateKeyArn,
      )
      const ghAppId = process.env['ORBITAL_GITHUB_APP_ID']
      if (ghAppId) this.apiLambda.fn.addEnvironment('ORBITAL_GITHUB_APP_ID', ghAppId)
    }

    // ------------------------------------------------------------------
    // 4.6 Events — SNS + SQS + EventBridge + consumer/scheduled Lambdas
    // Built before daemon so the SNS topic exists when DaemonFargateConstruct
    // wires its SQS subscription. This matches the original monolith order.
    // ------------------------------------------------------------------
    const eventsOut = buildEventsResources(
      this,
      props.envName,
      props.envConfig,
      api.wsFanoutFn,
      this.apiLambda,
      this.lambdas,
    )
    this.eventBus = eventsOut.eventBus

    // ------------------------------------------------------------------
    // 4.5 Daemon — ECS Fargate + EFS + ECR (after events so we have the topic)
    // ------------------------------------------------------------------
    buildDaemonResources(
      this,
      props.envName,
      props.envConfig,
      this.vpc,
      this.rdsProxy.lambdaSecurityGroup,
      this.rdsProxy.proxy,
      this.rdsProxy.proxy.endpoint,
      this.eventBus.snsTopic,
      this.secrets,
      this.perTenantKms,
      this.replayBucket,
    )

    // ------------------------------------------------------------------
    // Observability (stays inline — Phase 4.8 out of scope)
    // ------------------------------------------------------------------
    const allLambdaDescriptors: LambdaDescriptor[] = [
      { label: 'api-lambda',    fn: this.apiLambda.fn },
      { label: 'install',       fn: installLambdaConstruct.fn },
      { label: 'ws-connect',    fn: api.wsConnectFn },
      { label: 'ws-disconnect', fn: api.wsDisconnectFn },
      { label: 'ws-default',    fn: api.wsDefaultFn },
      { label: 'ws-fanout',     fn: api.wsFanoutFn },
      ...Object.entries(eventsOut.consumerFns).map(([name, fn]) => ({ label: `consumer-${name}`, fn })),
      ...Object.entries(eventsOut.scheduledFns).map(([name, fn]) => ({ label: `scheduled-${name}`, fn })),
    ]

    const sqsQueueDescriptors: SqsQueueDescriptor[] = [
      'memory-recorder',
      'defect-router',
      'audit-indexer',
      'replay-recorder',
    ].map((name) => ({
      label: name,
      queueName: `orbital-${props.envName}-${name}`,
      dlqName: `orbital-${props.envName}-${name}-dlq`,
    }))

    this.observability = new ObservabilityConstruct(this, 'Observability', {
      envName: props.envName,
      logRetentionDays: props.envConfig.logRetentionDays,
      httpApiId: this.apiGw.api.apiId,
      wsApiId: this.wsApi.apiId,
      auroraClusterIdentifier: this.aurora.cluster.clusterIdentifier,
      rdsProxyName: this.rdsProxy.proxy.dbProxyName,
      cognitoUserPoolId: this.cognito.userPool.userPoolId,
      lambdas: allLambdaDescriptors,
      sqsQueues: sqsQueueDescriptors,
      snsEventTopicArn: this.eventBus.snsTopic.topicArn,
      wafWebAclName: `orbital-${props.envName}-acl`,
      wsFanoutDlqName: `orbital-${props.envName}-ws-fanout-dlq`,
    })

    // Wire cold-path observability (metric filters + IAM alarm + dashboard)
    // after ObservabilityConstruct so we can reuse the existing alarm topic.
    this.apiLambda.addColdPathObservability(this.observability.alarmTopic)

    // ------------------------------------------------------------------
    // 4.7 Web — WAF + stack-level CloudFront/S3 outputs
    // ------------------------------------------------------------------
    const webOut = buildWebResources(
      this,
      props.envName,
      props.envConfig,
      this.staticUi,
      this.apiGw,
      this.wsApi,
      this.observability,
    )
    this.waf = webOut.waf

    // ------------------------------------------------------------------
    // Stack-level outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'StackName', {
      value: this.stackName,
      description: 'OrbitalHub CloudFormation stack name',
    })

    new cdk.CfnOutput(this, 'Environment', {
      value: props.envName,
      description: 'Orbital environment name',
    })

    new cdk.CfnOutput(this, 'Domain', {
      value: props.envConfig.domain,
      description: 'Orbital environment base domain',
    })

    new cdk.CfnOutput(this, 'CognitoAuthDomain', {
      value: this.cognito.userPoolDomain.baseUrl(),
      description: `Orbital ${props.envName} Cognito hosted UI base URL (orbital-${props.envName}.auth.${props.envConfig.region}.amazoncognito.com)`,
      exportName: `OrbitalHub-${props.envName}-CognitoAuthDomain`,
    })

    // Tag everything in this stack for cost allocation and filtering
    cdk.Tags.of(this).add('orbital:env', props.envName)
    cdk.Tags.of(this).add('orbital:stack', 'hub')
    cdk.Tags.of(this).add('orbital:managed-by', 'cdk')
  }
}

// ---------------------------------------------------------------------------
// 8-07 Secrets KMS - env-var name helpers re-exported for backward compat
// [Engineer-Principal · Opus · run-round8-07-secrets-kms]
// ---------------------------------------------------------------------------
export { secretEnvVarName, secretNameEnvVar, secretArnFor } from './stacks/secret-helpers'
