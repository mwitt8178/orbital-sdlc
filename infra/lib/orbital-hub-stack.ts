import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as path from 'path'
import { Construct } from 'constructs'
import { VpcConstruct } from './constructs/vpc'
import { DnsConstruct } from './constructs/dns'
import { CognitoConstruct } from './constructs/cognito'
// Round 8-02 Aurora imports - [Engineer-Sr · Sonnet · run-round8-02-aurora]
import { AuroraConstruct } from './constructs/aurora'
import { RdsProxyConstruct } from './constructs/rds-proxy'
import { RunMigrationsTrigger } from './triggers/run-migrations'
// 8-06 S3 imports
import { StaticUiConstruct } from './constructs/static-ui'
import { ReplayBucketConstruct } from './constructs/replay-bucket'
// 8-03 Lambda + API Gateway HTTP imports - [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
// Phase-1 migration: ApiLambdaConstruct replaces the 12-per-router LambdaTrpcConstruct
// for browser traffic. LambdaTrpcConstruct retained ONLY for the install→hub PKI route.
import { LambdaTrpcConstruct, RouterGroup } from './constructs/lambda-trpc'
import { ApiLambdaConstruct } from './constructs/api-lambda'
import { ApiGwHttpConstruct } from './constructs/api-gw-http'
import { AuthorizersConstruct } from './constructs/authorizers'
// 8-07 Secrets KMS imports - [Engineer-Principal · Opus · run-round8-07-secrets-kms]
import { SecretsConstruct, SecretRef, secretName } from './constructs/secrets'
import { PerTenantKmsConstruct } from './constructs/per-tenant-kms'
import { KeyRotationLambdaConstruct } from './constructs/key-rotation-lambda'
// 8-04 WebSocket API imports - [Engineer-Sr · Sonnet · run-round8-04-websocket-api]
import { ApiGwWsConstruct } from './constructs/api-gw-ws'
import { DynamoDbConnectionsConstruct } from './constructs/dynamodb-connections'
// 8-05 Event bus imports - [Engineer-Sr · Sonnet · run-round8-05-event-bus]
import { EventBusConstruct, type ConsumerName } from './constructs/event-bus'
// 8-08 Observability + WAF imports - [Engineer-Sr · Sonnet · run-round8-08-observability]
import { ObservabilityConstruct, type LambdaDescriptor, type SqsQueueDescriptor } from './constructs/observability'
import { WafConstruct } from './constructs/waf'
// Phase-2 migration: orchestrator daemon on Fargate
import { DaemonFargateConstruct } from './constructs/daemon-fargate'

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
}

export interface OrbitalHubStackProps extends cdk.StackProps {
  readonly envName: 'mwitt' | 'rreed' | 'prod'
  readonly envConfig: EnvConfig
}

/**
 * OrbitalHubStack - the single CDK stack for one Orbital environment.
 *
 * Sub-task attachment points (added in subsequent rounds):
 *  - 8-02: aurora (AuroraConstruct) + RDS Proxy
 *  - 8-03: lambdas (LambdaConstruct) + API Gateway HTTP
 *  - 8-04: WebSocket API + DynamoDB connections table
 *  - 8-05: SNS topic + SQS queues + EventBridge bus
 *  - 8-06: S3 buckets + CloudFront distribution
 *  - 8-07: Secrets Manager secrets + KMS keys
 *  - 8-08: CloudWatch alarms + WAF + X-Ray dashboard
 *
 * 8-01 wires: VPC + Cognito + DNS/ACM.
 */
export class OrbitalHubStack extends cdk.Stack {
  /**
   * The VPC for this environment. All compute and data resources sit inside it.
   */
  readonly vpc: ec2.IVpc

  /**
   * Cognito construct - exposes userPool, appClient, userPoolDomain.
   */
  readonly cognito: CognitoConstruct

  /**
   * DNS construct - exposes hostedZone and wildcard ACM certificate.
   * Undefined when useCustomDomain=false (mwitt env).
   */
  readonly dns: DnsConstruct | undefined

  // ------------------------------------------------------------------
  // Round 8-02 Aurora - [Engineer-Sr · Sonnet · run-round8-02-aurora]
  // ------------------------------------------------------------------
  /**
   * Aurora Serverless v2 construct - exposes cluster, securityGroup, masterSecret.
   */
  readonly aurora: AuroraConstruct

  /**
   * RDS Proxy construct - exposes proxy, proxySecurityGroup, lambdaSecurityGroup.
   */
  readonly rdsProxy: RdsProxyConstruct

  // 8-06 S3 - static UI + replay bucket constructs
  /**
   * Static UI construct - S3 bucket + CloudFront distribution.
   * [Engineer-Sr · Sonnet · run-round8-06-s3-cloudfront]
   */
  readonly staticUi: StaticUiConstruct

  /**
   * Replay bucket construct - SSE-KMS encrypted S3 bucket for replay blobs.
   * [Engineer-Sr · Sonnet · run-round8-06-s3-cloudfront]
   */
  readonly replayBucket: ReplayBucketConstruct

  // ------------------------------------------------------------------
  // Round 8-03 Lambda HTTP - [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
  // ------------------------------------------------------------------
  /**
   * Map of router group → Lambda construct.
   *
   * Phase-1 migration: previously held 12 entries (the per-router-group
   * Lambdas). Now holds ONLY `'tasks'` — the install→hub PKI route
   * Lambda. Browser traffic goes through `apiLambda` below.
   */
  readonly lambdas: Map<RouterGroup, LambdaTrpcConstruct>

  /**
   * The single api-lambda backing the browser tRPC surface.
   * Receives `/trpc/{proxy+}` (Cognito JWT) and `/public/{proxy+}` (no auth).
   * [Phase 1 migration]
   */
  readonly apiLambda: ApiLambdaConstruct

  /**
   * Authorizers construct - Cognito JWT + PKI envelope authorizers.
   */
  readonly authorizersConstruct: AuthorizersConstruct

  /**
   * HTTP API Gateway construct - routes + custom domain + CORS.
   */
  readonly apiGw: ApiGwHttpConstruct

  // ------------------------------------------------------------------
  // 8-07 Secrets KMS - [Engineer-Principal · Opus · run-round8-07-secrets-kms]
  // ------------------------------------------------------------------
  /**
   * SecretsConstruct - env-level Secrets Manager secrets + KMS CMK.
   */
  readonly secrets: SecretsConstruct

  /**
   * PerTenantKmsConstruct - IAM scaffolding for runtime per-tenant CMKs.
   * No CMKs are created at deploy time; runtime creation by onboarding Lambda.
   */
  readonly perTenantKms: PerTenantKmsConstruct

  /**
   * KeyRotationLambdaConstruct - rotates the hub master Ed25519 key every 90d.
   */
  readonly keyRotation: KeyRotationLambdaConstruct

  // ------------------------------------------------------------------
  // Round 8-04 WebSocket - [Engineer-Sr · Sonnet · run-round8-04-websocket-api]
  // ------------------------------------------------------------------
  /**
   * DynamoDB connections table - stores per-connection state with TTL.
   */
  readonly wsConnections: DynamoDbConnectionsConstruct

  /**
   * WebSocket API Gateway construct - $connect/$disconnect/$default routes.
   */
  readonly wsApi: ApiGwWsConstruct

  // ------------------------------------------------------------------
  // Round 8-05 Event bus - [Engineer-Sr · Sonnet · run-round8-05-event-bus]
  // ------------------------------------------------------------------
  /**
   * EventBusConstruct - SNS topic + SQS consumer queues + EventBridge bus + schedule rules.
   */
  readonly eventBus: EventBusConstruct

  // ------------------------------------------------------------------
  // 8-08 Observability + WAF - [Engineer-Sr · Sonnet · run-round8-08-observability]
  // ------------------------------------------------------------------
  /**
   * ObservabilityConstruct - CloudWatch dashboard, alarms, alarm SNS topic.
   */
  readonly observability: ObservabilityConstruct

  /**
   * WafConstruct - Web ACL + rules + API GW associations.
   */
  readonly waf: WafConstruct

  constructor(scope: Construct, id: string, props: OrbitalHubStackProps) {
    super(scope, id, {
      ...props,
      // Resolve the AWS account + region from context; fall back to CDK defaults
      env: {
        account:
          props.envConfig.account === '<TBD>'
            ? process.env['CDK_DEFAULT_ACCOUNT']
            : props.envConfig.account,
        region: props.envConfig.region,
      },
      description: `Orbital Hub - ${props.envName} environment (8-01: VPC + Cognito + DNS)`,
      // Termination protection for prod only
      terminationProtection: props.envName === 'prod',
    })

    // ------------------------------------------------------------------
    // VPC
    // ------------------------------------------------------------------
    const vpcConstruct = new VpcConstruct(this, 'Vpc', {
      envName: props.envName,
      logRetentionDays: props.envConfig.logRetentionDays,
    })
    this.vpc = vpcConstruct.vpc

    // ------------------------------------------------------------------
    // DNS + ACM
    // When useCustomDomain=false, the DnsConstruct is still instantiated
    // but creates no Route 53 / ACM resources (its hostedZone and
    // certificate properties are undefined).
    // ------------------------------------------------------------------
    // Resolve the flag - omitted/undefined is treated as true (backwards compat).
    const useCustomDomain = props.envConfig.useCustomDomain ?? true

    this.dns = new DnsConstruct(this, 'Dns', {
      domain: props.envConfig.domain,
      envName: props.envName,
      useCustomDomain,
    })

    // ------------------------------------------------------------------
    // Cognito
    // ------------------------------------------------------------------
    this.cognito = new CognitoConstruct(this, 'Cognito', {
      envName: props.envName,
      enableMfa: props.envConfig.enableMfa,
      domain: props.envConfig.domain,
      // hostedZone is undefined when useCustomDomain=false; cognito.ts
      // will skip the Route 53 A-record in that case.
      hostedZone: this.dns.hostedZone,
    })

    // ------------------------------------------------------------------
    // Round 8-02 Aurora attach
    // [Engineer-Sr · Sonnet · run-round8-02-aurora]
    // ------------------------------------------------------------------

    // Step 1: Create a preliminary security group for the RDS Proxy so
    // AuroraConstruct can reference it before the full RdsProxyConstruct
    // is instantiated. The real proxy SG is created inside RdsProxyConstruct;
    // we pass a forward reference by constructing the proxy first, then Aurora.
    //
    // Construction order:
    //   RdsProxyConstruct (creates proxySecurityGroup + lambdaSecurityGroup)
    //   → AuroraConstruct (uses proxySecurityGroup as allowedSg)
    //   → RunMigrationsTrigger (wires proxy + cluster + Lambda SG)

    // We create RdsProxyConstruct first to get the proxy SG reference,
    // but the cluster property is filled by the aurora construct.
    // CDK resolves these circular dependencies via lazy tokens, so we
    // pass a placeholder cluster and the real cluster is set via
    // CDK's dependency graph.
    //
    // Practical solution: Create a standalone proxy SG first, pass it to
    // Aurora, then construct the full RdsProxyConstruct with Aurora's cluster.

    // Standalone Proxy SG (Aurora references this; proxy construct uses it)
    const proxySgForAurora = new ec2.SecurityGroup(this, 'ProxySgRef', {
      vpc: this.vpc,
      securityGroupName: `orbital-${props.envName}-rds-proxy`,
      description: `Orbital ${props.envName} - RDS Proxy SG (forward ref for Aurora). Managed by RdsProxyConstruct.`,
      allowAllOutbound: false,
    })

    // Aurora construct - receives the proxy SG as its allowedSg
    this.aurora = new AuroraConstruct(this, 'Aurora', {
      envName: props.envName,
      vpc: this.vpc,
      minAcu: props.envConfig.auroraMinAcu,
      maxAcu: props.envConfig.auroraMaxAcu,
      logRetentionDays: props.envConfig.logRetentionDays,
      allowedSg: proxySgForAurora,
    })

    // RDS Proxy construct - creates Lambda SG, proxy SG (imports proxySgForAurora
    // by reference), and the DatabaseProxy resource fronting Aurora.
    this.rdsProxy = new RdsProxyConstruct(this, 'RdsProxy', {
      envName: props.envName,
      vpc: this.vpc,
      cluster: this.aurora.cluster,
      masterSecret: this.aurora.masterSecret,
      existingProxySg: proxySgForAurora,
    })

    // Migration runner trigger - invokes on every cdk deploy
    new RunMigrationsTrigger(this, 'Migrations', {
      envName: props.envName,
      vpc: this.vpc,
      proxy: this.rdsProxy.proxy,
      proxyEndpoint: this.rdsProxy.proxy.endpoint,
      cluster: this.aurora.cluster,
      masterSecret: this.aurora.masterSecret,
      lambdaSg: this.rdsProxy.lambdaSecurityGroup,
      logRetentionDays: props.envConfig.logRetentionDays,
    })

    // ------------------------------------------------------------------
    // (end Round 8-02 Aurora)
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // 8-06 S3 - Static UI bucket + CloudFront + Replay bucket
    // [Engineer-Sr · Sonnet · run-round8-06-s3-cloudfront]
    // ------------------------------------------------------------------
    this.staticUi = new StaticUiConstruct(this, 'StaticUi', {
      envName: props.envName,
      domain: props.envConfig.domain,
      // certificate and hostedZone are undefined when useCustomDomain=false;
      // StaticUiConstruct skips domainNames/Route53 in that case.
      certificate: this.dns.certificate,
      hostedZone: this.dns.hostedZone,
    })

    this.replayBucket = new ReplayBucketConstruct(this, 'ReplayBucket', {
      envName: props.envName,
      retentionYears: 7,
    })
    // ------------------------------------------------------------------
    // (end 8-06 S3)
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // 8-03 Lambda HTTP - Lambda functions + API Gateway + Authorizers
    // [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
    // ------------------------------------------------------------------

    // Authorizers: Cognito JWT + PKI envelope
    this.authorizersConstruct = new AuthorizersConstruct(this, 'Authorizers', {
      envName: props.envName,
      userPool: this.cognito.userPool,
      appClientId: this.cognito.appClient.userPoolClientId,
      region: props.envConfig.region,
      vpc: this.vpc,
      lambdaSg: this.rdsProxy.lambdaSecurityGroup,
      rdsProxy: this.rdsProxy.proxy,
      proxyEndpoint: this.rdsProxy.proxy.endpoint,
      logRetentionDays: props.envConfig.logRetentionDays,
    })

    // ----- Phase 1 migration -----
    //
    // Browser tRPC traffic flows through a SINGLE ApiLambdaConstruct that
    // bundles the @orbital/api-lambda package (a narrow router that
    // deliberately excludes daemon-shaped procedures).
    //
    // The legacy LambdaTrpcConstruct is retained ONLY for the install→hub
    // PKI route at `/install/{proxy+}` because the install Lambda has its
    // own auth model and is invoked by remote installs, not browsers.
    //
    // The previous 12-Lambdas-per-router architecture is removed: only
    // `trpc-all` was wired to a route, and importing the eager root
    // appRouter caused INIT crashes (see docs/module-import-side-effects.md).
    // ------------------------------

    // Single api-lambda for all browser traffic.
    this.apiLambda = new ApiLambdaConstruct(this, 'ApiLambda', {
      envName: props.envName,
      vpc: this.vpc,
      lambdaSg: this.rdsProxy.lambdaSecurityGroup,
      rdsProxy: this.rdsProxy.proxy,
      proxyEndpoint: this.rdsProxy.proxy.endpoint,
      logRetentionDays: props.envConfig.logRetentionDays,
      cognitoUserPoolId: this.cognito.userPool.userPoolId,
      cognitoAppClientId: this.cognito.appClient.userPoolClientId,
      region: props.envConfig.region,
      // Phase 1.11: enable PC after first deploy is healthy (env flag).
      enableProvisionedConcurrency: process.env['ORBITAL_ENABLE_PC'] === '1',
    })

    // Replay bucket grant — api-lambda serves audit procedures that read
    // replay blobs on demand.
    this.replayBucket.bucket.grantRead(this.apiLambda.role)

    // Install Lambda — single survivor of the legacy per-router Lambdas.
    // Backs `/install/{proxy+}` with the PKI envelope authorizer. Code
    // path is the `tasks` router group (claim work, append events).
    this.lambdas = new Map<RouterGroup, LambdaTrpcConstruct>()
    const installLambda = new LambdaTrpcConstruct(this, 'Lambda-tasks', {
      routerGroup: 'tasks',
      envName: props.envName,
      vpc: this.vpc,
      lambdaSg: this.rdsProxy.lambdaSecurityGroup,
      rdsProxy: this.rdsProxy.proxy,
      secretArns: {},
      proxyEndpoint: this.rdsProxy.proxy.endpoint,
      logRetentionDays: props.envConfig.logRetentionDays,
      cognitoUserPoolId: this.cognito.userPool.userPoolId,
      cognitoAppClientId: this.cognito.appClient.userPoolClientId,
      region: props.envConfig.region,
    })
    this.lambdas.set('tasks', installLambda)

    // ------------------------------------------------------------------
    // API Gateway HTTP — three routes, one Lambda for browser traffic.
    //
    //   /trpc/{proxy+}    — JWT-protected; api-lambda
    //   /public/{proxy+}  — no authorizer; api-lambda (SetupGate, health)
    //   /install/{proxy+} — PKI envelope; install Lambda
    // ------------------------------------------------------------------
    const routeConfigs = [
      // Browser-facing tRPC. Phase 1 keeps the `none` authorizer so the
      // SetupGate (which calls onboarding.status pre-login) and other
      // anonymous procedures continue to work without UI changes. The
      // api-lambda's handler extracts JWT claims from the Authorization
      // header when present — authed procedures throw UNAUTHORIZED at the
      // tRPC layer if claims are missing. Phase 4 (auth-stack split) moves
      // to gateway-level JWT auth with a proper /public/ route prefix and
      // updates the UI client to use `splitLink` for routing.
      {
        routeKey: 'ANY /trpc/{proxy+}',
        fn: this.apiLambda.fn,
        authType: 'none' as const,
      },
      // /public/{proxy+} — provisioned now so the UI can be migrated
      // procedure-by-procedure during Phase 4 without another CDK deploy.
      // Same Lambda; no authorizer.
      {
        routeKey: 'ANY /public/{proxy+}',
        fn: this.apiLambda.fn,
        authType: 'none' as const,
      },
      // Install-to-hub PKI envelope route — unchanged from prior design.
      {
        routeKey: 'ANY /install/{proxy+}',
        fn: installLambda.fn,
        authType: 'install' as const,
      },
    ]

    this.apiGw = new ApiGwHttpConstruct(this, 'ApiGw', {
      envName: props.envName,
      domain: props.envConfig.domain,
      certificate: this.dns.certificate,
      hostedZone: this.dns.hostedZone,
      cognitoAuthorizer: this.authorizersConstruct.cognitoAuthorizer,
      installAuthorizer: this.authorizersConstruct.installAuthorizer,
      routes: routeConfigs,
      logRetentionDays: props.envConfig.logRetentionDays,
    })

    // ------------------------------------------------------------------
    // (end Round 8-03 Lambda HTTP)
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // 8-07 Secrets KMS - Secrets Manager + KMS + per-tenant CMK IAM + rotation
    // [Engineer-Principal · Opus · run-round8-07-secrets-kms]
    // ------------------------------------------------------------------
    // SecretsConstruct provisions:
    //   - hub-master-key (Ed25519, rotated every 90 days)
    //   - github-webhook-secret (manual rotation)
    //   - cognito-app-client-secret (only if explicitly requested; PKCE SPA
    //     client from 8-01 has no secret)
    // It also attaches the AWS-hosted single-user PG rotation Lambda to the
    // existing Aurora master credentials secret (30-day rotation). We do NOT
    // create a duplicate db-master-creds secret; we extend the 8-02 Aurora
    // secret in place.
    this.secrets = new SecretsConstruct(this, 'Secrets', {
      envName: props.envName,
      dbMasterSecret: this.aurora.masterSecret,
      // PKCE app client has no secret; flip to true for OAuth confidential clients.
      provisionCognitoClientSecret: false,
    })

    // PerTenantKmsConstruct: IAM-only construct. CMKs are created at runtime
    // by the onboarding Lambda when a new tenant signs up.
    this.perTenantKms = new PerTenantKmsConstruct(this, 'PerTenantKms', {
      envName: props.envName,
      account: cdk.Stack.of(this).account,
      region: props.envConfig.region,
    })

    // KeyRotationLambdaConstruct: rotates the hub master key every 90 days.
    this.keyRotation = new KeyRotationLambdaConstruct(this, 'KeyRotation', {
      envName: props.envName,
      hubMasterKeySecret: this.secrets.hubMasterKeySecret,
      encryptionKey: this.secrets.hubMasterKeyEncryptionKey,
      logRetentionDays: props.envConfig.logRetentionDays,
      rotationDays: 90,
    })
    // The rotation Lambda is the ONLY caller permitted to write the secret.
    this.secrets.grantWriteHubMasterKey(this.keyRotation.fn)

    // Per-Lambda IAM scoping - tight grants, principle of least privilege.
    //
    // Each Lambda group declares the minimum set of secrets it must access.
    // Wrong scoping = secret leak across boundaries - covered by IAM scoping
    // tests in secrets.test.ts.
    // Phase-1 migration: api-lambda needs every secret any browser-served
    // procedure transitively touches — DB creds, hub master key (install
    // path invoked from browser via /trpc/install.* helpers), GitHub
    // webhook secret (prs router HMAC verify when re-checked from browser).
    const apiLambdaSecretRefs: SecretRef[] = ['dbMasterCreds', 'hubMasterKey', 'githubWebhookSecret']
    this.secrets.grantReadFor(this.apiLambda.role, apiLambdaSecretRefs)
    for (const ref of apiLambdaSecretRefs) {
      this.apiLambda.fn.addEnvironment(secretEnvVarName(ref), secretArnFor(this.secrets, ref))
      this.apiLambda.fn.addEnvironment(secretNameEnvVar(ref), secretName(props.envName, ref))
    }

    // Install Lambda — needs DB + hub master key (envelope verify).
    const installSecretRefs: SecretRef[] = ['dbMasterCreds', 'hubMasterKey']
    const installLambdaConstruct = this.lambdas.get('tasks')!
    this.secrets.grantReadFor(installLambdaConstruct.role, installSecretRefs)
    for (const ref of installSecretRefs) {
      installLambdaConstruct.fn.addEnvironment(secretEnvVarName(ref), secretArnFor(this.secrets, ref))
      installLambdaConstruct.fn.addEnvironment(secretNameEnvVar(ref), secretName(props.envName, ref))
    }

    // Per-tenant KMS grants:
    //   - api-lambda: USE per-tenant CMKs (decrypt replay blobs for audit
    //     procedures) AND CREATE+USE+DELETE (onboarding flow provisions
    //     a tenant CMK; admin flow may delete on offboarding).
    this.perTenantKms.grantPerTenantUsage(this.apiLambda.role)
    this.perTenantKms.grantOnboardingPermissions(this.apiLambda.role)
    this.perTenantKms.grantTenantDeletion(this.apiLambda.role)

    // ------------------------------------------------------------------
    // (end 8-07 Secrets KMS)
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // 8-04 WebSocket - API Gateway WS + DynamoDB connections table
    // [Engineer-Sr · Sonnet · run-round8-04-websocket-api]
    // ------------------------------------------------------------------

    // DynamoDB connections table (PK: connection_id, GSI: install_id, tenant_id)
    this.wsConnections = new DynamoDbConnectionsConstruct(this, 'WsConnections', {
      envName: props.envName,
    })

    // Code path shared with tRPC Lambdas
    // From infra/lib/ (the stack file's __dirname at ts-node runtime),
    // two levels up reaches the monorepo root (orbital/), then into packages/.
    // Note: individual constructs in infra/lib/constructs/ use '../../../' because
    // they are one level deeper. This file is at infra/lib/, so '../../' is correct.
    const orchestratorDist = path.resolve(
      __dirname,
      '../../packages/orchestrator/dist',
    )

    const wsLogRetention = props.envConfig.logRetentionDays as logs.RetentionDays
    const isProd = props.envName === 'prod'

    // Shared environment variables for all WS Lambdas
    const wsLambdaEnv: Record<string, string> = {
      ORBITAL_DEPLOY_TARGET: 'aws',
      ORBITAL_ENV: props.envName,
      CONNECTIONS_TABLE: this.wsConnections.table.tableName,
      AWS_ACCOUNT_ID: this.account,
      COGNITO_USER_POOL_ID: this.cognito.userPool.userPoolId,
      COGNITO_APP_CLIENT_ID: this.cognito.appClient.userPoolClientId,
    }

    // ------------------------------------------------------------------
    // $connect Lambda
    // ------------------------------------------------------------------
    const wsConnectLogGroup = new logs.LogGroup(this, 'WsConnectLogGroup', {
      logGroupName: `/orbital/${props.envName}/lambda/ws-connect`,
      retention: wsLogRetention,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    const wsConnectRole = new iam.Role(this, 'WsConnectRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Orbital ${props.envName} WS $connect Lambda execution role`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    })

    const wsConnectFn = new lambda.Function(this, 'WsConnectFn', {
      functionName: `orbital-${props.envName}-ws-connect`,
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

    // Grant DynamoDB putItem (connect writes the row)
    this.wsConnections.table.grantWriteData(wsConnectRole)

    // X-Ray
    wsConnectRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    }))

    // ------------------------------------------------------------------
    // $disconnect Lambda
    // ------------------------------------------------------------------
    const wsDisconnectLogGroup = new logs.LogGroup(this, 'WsDisconnectLogGroup', {
      logGroupName: `/orbital/${props.envName}/lambda/ws-disconnect`,
      retention: wsLogRetention,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    const wsDisconnectRole = new iam.Role(this, 'WsDisconnectRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Orbital ${props.envName} WS $disconnect Lambda execution role`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    })

    const wsDisconnectFn = new lambda.Function(this, 'WsDisconnectFn', {
      functionName: `orbital-${props.envName}-ws-disconnect`,
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

    // Grant DynamoDB deleteItem (disconnect removes the row)
    this.wsConnections.table.grantWriteData(wsDisconnectRole)

    wsDisconnectRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    }))

    // ------------------------------------------------------------------
    // $default Lambda (subscribe/unsubscribe/ping)
    // ------------------------------------------------------------------
    const wsDefaultLogGroup = new logs.LogGroup(this, 'WsDefaultLogGroup', {
      logGroupName: `/orbital/${props.envName}/lambda/ws-default`,
      retention: wsLogRetention,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    const wsDefaultRole = new iam.Role(this, 'WsDefaultRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Orbital ${props.envName} WS $default Lambda execution role`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    })

    // Needs read + write: GetItem (load subscriptions), UpdateItem (update subscriptions)
    this.wsConnections.table.grantReadWriteData(wsDefaultRole)

    wsDefaultRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    }))

    // ------------------------------------------------------------------
    // WebSocket API - instantiate BEFORE wsDefaultFn so we can inject
    // the management endpoint as an env var on the default Lambda.
    // ------------------------------------------------------------------

    // We need to create the API first to get the management endpoint.
    // The default Lambda's env var is set after the API is created.

    const wsDefaultFn = new lambda.Function(this, 'WsDefaultFn', {
      functionName: `orbital-${props.envName}-ws-default`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'lambda/ws/default.handler',
      code: lambda.Code.fromAsset(orchestratorDist, {
        exclude: ['**/*.test.*', '**/*.spec.*', '**/test/**'],
      }),
      role: wsDefaultRole,
      timeout: cdk.Duration.seconds(29),
      memorySize: 512,
      // WS_MGMT_ENDPOINT will be added below after wsApi is constructed
      environment: wsLambdaEnv,
      logGroup: wsDefaultLogGroup,
      tracing: lambda.Tracing.ACTIVE,
    })

    // WebSocket API construct - creates routes + (conditional) custom domain + stage
    this.wsApi = new ApiGwWsConstruct(this, 'WsApi', {
      envName: props.envName,
      domain: props.envConfig.domain,
      // certificate and hostedZone are undefined when useCustomDomain=false;
      // ApiGwWsConstruct skips custom domain + Route53 record in that case.
      certificate: this.dns.certificate,
      hostedZone: this.dns.hostedZone,
      connectFn: wsConnectFn,
      disconnectFn: wsDisconnectFn,
      defaultFn: wsDefaultFn,
      logRetentionDays: props.envConfig.logRetentionDays,
    })

    // Inject management endpoint into default Lambda (needed for postToConnection)
    wsDefaultFn.addEnvironment('WS_MGMT_ENDPOINT', this.wsApi.managementApiEndpoint)
    wsDefaultFn.addEnvironment('WS_API_ID', this.wsApi.apiId)

    // ------------------------------------------------------------------
    // Fanout Lambda - SNS-triggered, posts to connections via Mgmt API
    // ------------------------------------------------------------------
    const wsFanoutLogGroup = new logs.LogGroup(this, 'WsFanoutLogGroup', {
      logGroupName: `/orbital/${props.envName}/lambda/ws-fanout`,
      retention: wsLogRetention,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    // DLQ for fanout failures
    const wsFanoutDlq = new cdk.aws_sqs.Queue(this, 'WsFanoutDlq', {
      queueName: `orbital-${props.envName}-ws-fanout-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: cdk.aws_sqs.QueueEncryption.KMS_MANAGED,
    })

    const wsFanoutRole = new iam.Role(this, 'WsFanoutRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Orbital ${props.envName} WS fanout Lambda execution role`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    })

    // Needs DynamoDB read (QueryGSI) + deleteItem (stale connections)
    this.wsConnections.table.grantReadWriteData(wsFanoutRole)

    // Needs API GW management: postToConnection
    wsFanoutRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['execute-api:ManageConnections'],
      resources: [
        `arn:aws:execute-api:${this.region}:${this.account}:${this.wsApi.apiId}/${this.wsApi.stageName}/*`,
      ],
    }))

    wsFanoutRole.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    }))

    // DLQ send permission
    wsFanoutDlq.grantSendMessages(wsFanoutRole)

    const wsFanoutFn = new lambda.Function(this, 'WsFanoutFn', {
      functionName: `orbital-${props.envName}-ws-fanout`,
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
        WS_MGMT_ENDPOINT: this.wsApi.managementApiEndpoint,
        WS_API_ID: this.wsApi.apiId,
      },
      logGroup: wsFanoutLogGroup,
      tracing: lambda.Tracing.ACTIVE,
      deadLetterQueue: wsFanoutDlq,
    })

    // Output the fanout Lambda ARN so 8-05 (SNS) can subscribe it
    new cdk.CfnOutput(this, 'WsFanoutFnArn', {
      value: wsFanoutFn.functionArn,
      description: `Orbital ${props.envName} WS fanout Lambda ARN (subscribe to SNS in 8-05)`,
      exportName: `OrbitalHub-${props.envName}-WsFanoutFnArn`,
    })

    // ------------------------------------------------------------------
    // (end 8-04 WebSocket)
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // 8-05 Event bus - SNS + SQS + EventBridge
    // [Engineer-Sr · Sonnet · run-round8-05-event-bus]
    // ------------------------------------------------------------------

    // Consumer Lambda functions - one per SQS queue
    const consumerHandlers: Record<ConsumerName, string> = {
      'memory-recorder': 'lambda/consumers/memory-recorder.handler',
      'defect-router':   'lambda/consumers/defect-router.handler',
      'audit-indexer':   'lambda/consumers/audit-indexer.handler',
      'replay-recorder': 'lambda/consumers/replay-recorder.handler',
    }

    const consumerFns: Record<ConsumerName, lambda.Function> = {} as Record<ConsumerName, lambda.Function>

    for (const [consumerName, handlerPath] of Object.entries(consumerHandlers) as [ConsumerName, string][]) {
      const logGroup = new logs.LogGroup(this, `Consumer-${consumerName}-LogGroup`, {
        logGroupName: `/orbital/${props.envName}/lambda/consumer-${consumerName}`,
        retention: props.envConfig.logRetentionDays as logs.RetentionDays,
        removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      })

      const role = new iam.Role(this, `Consumer-${consumerName}-Role`, {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        description: `Orbital ${props.envName} ${consumerName} consumer Lambda execution role`,
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        ],
      })

      role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
        resources: ['*'],
      }))

      consumerFns[consumerName] = new lambda.Function(this, `Consumer-${consumerName}-Fn`, {
        functionName: `orbital-${props.envName}-consumer-${consumerName}`,
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: handlerPath,
        code: lambda.Code.fromAsset(orchestratorDist, {
          exclude: ['**/*.test.*', '**/*.spec.*', '**/test/**'],
        }),
        role,
        timeout: cdk.Duration.seconds(60),
        memorySize: 256,
        environment: {
          ORBITAL_DEPLOY_TARGET: 'aws',
          ORBITAL_ENV: props.envName,
          NODE_ENV: 'production',
        },
        logGroup,
        tracing: lambda.Tracing.ACTIVE,
      })
    }

    // Scheduled Lambda functions
    const scheduledDefs: Array<{ name: string; handler: string }> = [
      { name: 'sprint-planning', handler: 'lambda/scheduled/sprint-planning.handler' },
      { name: 'retro-runner',    handler: 'lambda/scheduled/retro-runner.handler' },
      { name: 'hygiene-sweep',   handler: 'lambda/scheduled/hygiene-sweep.handler' },
    ]

    const scheduledFns: Record<string, lambda.Function> = {}

    for (const { name, handler: handlerPath } of scheduledDefs) {
      const logGroup = new logs.LogGroup(this, `Scheduled-${name}-LogGroup`, {
        logGroupName: `/orbital/${props.envName}/lambda/scheduled-${name}`,
        retention: props.envConfig.logRetentionDays as logs.RetentionDays,
        removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      })

      const role = new iam.Role(this, `Scheduled-${name}-Role`, {
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
        description: `Orbital ${props.envName} ${name} scheduled Lambda execution role`,
        managedPolicies: [
          iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        ],
      })

      role.addToPolicy(new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
        resources: ['*'],
      }))

      scheduledFns[name] = new lambda.Function(this, `Scheduled-${name}-Fn`, {
        functionName: `orbital-${props.envName}-scheduled-${name}`,
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: handlerPath,
        code: lambda.Code.fromAsset(orchestratorDist, {
          exclude: ['**/*.test.*', '**/*.spec.*', '**/test/**'],
        }),
        role,
        timeout: cdk.Duration.seconds(300),
        memorySize: 256,
        environment: {
          ORBITAL_DEPLOY_TARGET: 'aws',
          ORBITAL_ENV: props.envName,
          NODE_ENV: 'production',
        },
        logGroup,
        tracing: lambda.Tracing.ACTIVE,
      })
    }

    // Instantiate EventBusConstruct - wires SNS, SQS, EventBridge, filter policies
    this.eventBus = new EventBusConstruct(this, 'EventBus', {
      envName: props.envName,
      wsFanoutFn,
      consumerFns,
      sprintPlanningFn: scheduledFns['sprint-planning']!,
      retroRunnerFn:    scheduledFns['retro-runner']!,
      hygieneSweepFn:   scheduledFns['hygiene-sweep']!,
    })

    // Phase-1 migration: api-lambda publishes browser-originated events,
    // install Lambda publishes events from install→hub work claims.
    this.apiLambda.fn.addEnvironment('EVENTS_TOPIC_ARN', this.eventBus.snsTopic.topicArn)
    this.eventBus.grantPublish(this.apiLambda.role)
    installLambdaConstruct.fn.addEnvironment('EVENTS_TOPIC_ARN', this.eventBus.snsTopic.topicArn)
    this.eventBus.grantPublish(installLambdaConstruct.role)

    // Also inject into consumer Lambdas (defect-router may re-publish cross-install events)
    consumerFns['defect-router'].addEnvironment('EVENTS_TOPIC_ARN', this.eventBus.snsTopic.topicArn)
    // grantPublish requires IGrantable - lambda.Function implements IGrantable directly.
    this.eventBus.grantPublish(consumerFns['defect-router'])

    // Inject EVENTS_TOPIC_ARN into ws-fanout (it already has the subscription via SNS)
    wsFanoutFn.addEnvironment('EVENTS_TOPIC_ARN', this.eventBus.snsTopic.topicArn)

    // ------------------------------------------------------------------
    // (end 8-05 Event bus)
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // Phase-2 migration — orchestrator daemon on Fargate.
    //
    // First-pass deploy provisions ECR + EFS + SQS + IAM. Without
    // imageDigest the Fargate Service is NOT created — the operator
    // builds and pushes the daemon image, then redeploys with the
    // ORBITAL_DAEMON_IMAGE_DIGEST env var set, which wires the running
    // service in the second pass.
    // ------------------------------------------------------------------
    const daemonImageDigest = process.env['ORBITAL_DAEMON_IMAGE_DIGEST']
    const daemonSecretRefs: SecretRef[] = ['dbMasterCreds', 'hubMasterKey', 'githubWebhookSecret']
    const daemonSecretEnvVars: Record<string, string> = {}
    for (const ref of daemonSecretRefs) {
      daemonSecretEnvVars[secretEnvVarName(ref)] = secretArnFor(this.secrets, ref)
      daemonSecretEnvVars[secretNameEnvVar(ref)] = secretName(props.envName, ref)
    }
    const daemon = new DaemonFargateConstruct(this, 'Daemon', {
      envName: props.envName,
      vpc: this.vpc,
      lambdaSg: this.rdsProxy.lambdaSecurityGroup,
      rdsProxy: this.rdsProxy.proxy,
      proxyEndpoint: this.rdsProxy.proxy.endpoint,
      logRetentionDays: props.envConfig.logRetentionDays,
      eventsTopic: this.eventBus.snsTopic,
      secretEnvVars: daemonSecretEnvVars,
      ...(daemonImageDigest !== undefined ? { imageDigest: daemonImageDigest } : {}),
    })
    // Grant daemon task role read access to the same secrets.
    this.secrets.grantReadFor(daemon.taskRole, daemonSecretRefs)
    // Per-tenant KMS — daemon needs CREATE+USE for onboarding flow + USE
    // for replay decrypt and DELETE for offboarding.
    this.perTenantKms.grantPerTenantUsage(daemon.taskRole)
    this.perTenantKms.grantOnboardingPermissions(daemon.taskRole)
    this.perTenantKms.grantTenantDeletion(daemon.taskRole)
    // Replay bucket read+write — daemon writes replay blobs.
    this.replayBucket.bucket.grantReadWrite(daemon.taskRole)

    // ------------------------------------------------------------------
    // 8-08 Observability - WAF + CloudWatch Dashboard + Alarms
    // [Engineer-Sr · Sonnet · run-round8-08-observability]
    // ------------------------------------------------------------------

    // Build the lambda descriptor list - api-lambda + install + WS + consumer + scheduled
    const allLambdaDescriptors: LambdaDescriptor[] = [
      // Phase-1 migration: single api-lambda backs all browser tRPC traffic.
      { label: 'api-lambda', fn: this.apiLambda.fn },
      // Install Lambda — sole survivor of legacy per-router Lambdas.
      { label: 'install', fn: installLambdaConstruct.fn },
      // WS Lambdas
      { label: 'ws-connect',    fn: wsConnectFn },
      { label: 'ws-disconnect', fn: wsDisconnectFn },
      { label: 'ws-default',    fn: wsDefaultFn },
      { label: 'ws-fanout',     fn: wsFanoutFn },
      // Consumer Lambdas
      ...Object.entries(consumerFns).map(([name, fn]) => ({
        label: `consumer-${name}`,
        fn,
      })),
      // Scheduled Lambdas
      ...Object.entries(scheduledFns).map(([name, fn]) => ({
        label: `scheduled-${name}`,
        fn,
      })),
    ]

    // Build SQS queue descriptors for the dashboard + alarms
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

    // WAF - must be created before observability so we can pass the alarm topic ARN
    // We use a two-step: create WAF first, then observability with alarmTopicArn,
    // then feed observability's alarm topic back into WAF via the wafConstruct
    // property. Since we're doing it in order, create observability first with
    // a placeholder, OR create WAF with no alarm initially and call addAlarmAction
    // on the blocked-requests alarm post-hoc. We choose: create observability first,
    // then WAF with the alarm topic ARN from observability.

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

    // WAF - REGIONAL WebACL associated with HTTP API + WebSocket API
    // The HTTP API ARN for WAF association follows the pattern:
    //   arn:aws:apigateway:{region}::/restapis/{apiId}/stages/{stage}
    // For HTTP API v2 + WAF, the association ARN is the stage ARN:
    //   arn:aws:apigateway:{region}::/apis/{apiId}/stages/{stage}
    const httpApiStageArn = cdk.Stack.of(this).formatArn({
      service: 'apigateway',
      account: '',
      resource: `/apis/${this.apiGw.api.apiId}/stages/$default`,
    })

    const wsApiStageArn = cdk.Stack.of(this).formatArn({
      service: 'apigateway',
      account: '',
      resource: `/apis/${this.wsApi.apiId}/stages/${this.wsApi.stageName}`,
    })

    this.waf = new WafConstruct(this, 'Waf', {
      envName: props.envName,
      httpApiArn: httpApiStageArn,
      wsApiArn: wsApiStageArn,
      logRetentionDays: props.envConfig.logRetentionDays,
      alarmTopicArn: this.observability.alarmTopic.topicArn,
    })

    // ------------------------------------------------------------------
    // (end 8-08 Observability + WAF)
    // ------------------------------------------------------------------

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

    // ------------------------------------------------------------------
    // Generated-URL outputs (most useful when useCustomDomain=false)
    // These are always emitted so the operator can find the live URLs
    // post-deploy without digging through the console.
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'CognitoAuthDomain', {
      value: this.cognito.userPoolDomain.baseUrl(),
      description: `Orbital ${props.envName} Cognito hosted UI base URL (orbital-${props.envName}.auth.${props.envConfig.region}.amazoncognito.com)`,
      exportName: `OrbitalHub-${props.envName}-CognitoAuthDomain`,
    })

    new cdk.CfnOutput(this, 'UiBucketName', {
      value: this.staticUi.bucket.bucketName,
      description: `Orbital ${props.envName} UI S3 bucket name`,
      exportName: `OrbitalHub-${props.envName}-UiBucketNameStack`,
    })

    new cdk.CfnOutput(this, 'CloudFrontDomain', {
      value: this.staticUi.distribution.distributionDomainName,
      description: `Orbital ${props.envName} CloudFront distribution domain (*.cloudfront.net)`,
      exportName: `OrbitalHub-${props.envName}-CloudFrontDomain`,
    })

    // Tag everything in this stack for cost allocation and filtering
    cdk.Tags.of(this).add('orbital:env', props.envName)
    cdk.Tags.of(this).add('orbital:stack', 'hub')
    cdk.Tags.of(this).add('orbital:managed-by', 'cdk')
  }
}

// ---------------------------------------------------------------------------
// 8-07 Secrets KMS - env-var name helpers
// [Engineer-Principal · Opus · run-round8-07-secrets-kms]
// ---------------------------------------------------------------------------

/**
 * Convert a secret ref into the canonical Lambda env var name for the secret ARN.
 * The orchestrator runtime reads these env vars in secrets-cache.ts:
 *   getSecrets → reads ORBITAL_HUB_MASTER_KEY_SECRET_ARN, ORBITAL_DB_CREDS_SECRET_ARN, ...
 */
function secretEnvVarName(ref: SecretRef): string {
  switch (ref) {
    case 'hubMasterKey':
      return 'ORBITAL_HUB_MASTER_KEY_SECRET_ARN'
    case 'dbMasterCreds':
      return 'ORBITAL_DB_CREDS_SECRET_ARN'
    case 'githubWebhookSecret':
      return 'ORBITAL_GITHUB_WEBHOOK_SECRET_ARN'
    case 'cognitoAppClientSecret':
      return 'ORBITAL_COGNITO_APP_CLIENT_SECRET_ARN'
  }
}

/**
 * Convert a secret ref into the env var holding the secret NAME (alternative
 * to ARN - some AWS SDK clients are happier with the name).
 */
function secretNameEnvVar(ref: SecretRef): string {
  return secretEnvVarName(ref).replace('_ARN', '_NAME')
}

function secretArnFor(secrets: SecretsConstruct, ref: SecretRef): string {
  switch (ref) {
    case 'hubMasterKey':
      return secrets.hubMasterKeySecret.secretArn
    case 'dbMasterCreds':
      return secrets.dbMasterSecret.secretArn
    case 'githubWebhookSecret':
      return secrets.githubWebhookSecret.secretArn
    case 'cognitoAppClientSecret':
      if (!secrets.cognitoAppClientSecret) {
        throw new Error('cognitoAppClientSecret was not provisioned')
      }
      return secrets.cognitoAppClientSecret.secretArn
  }
}
