import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { Construct } from 'constructs'
import { VpcConstruct } from './constructs/vpc'
import { DnsConstruct } from './constructs/dns'
import { CognitoConstruct } from './constructs/cognito'
// Round 8-02 Aurora imports — [Engineer-Sr · Sonnet · run-round8-02-aurora]
import { AuroraConstruct } from './constructs/aurora'
import { RdsProxyConstruct } from './constructs/rds-proxy'
import { RunMigrationsTrigger } from './triggers/run-migrations'
// 8-06 S3 imports
import { StaticUiConstruct } from './constructs/static-ui'
import { ReplayBucketConstruct } from './constructs/replay-bucket'
// 8-03 Lambda + API Gateway HTTP imports — [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
import { LambdaTrpcConstruct, RouterGroup } from './constructs/lambda-trpc'
import { ApiGwHttpConstruct } from './constructs/api-gw-http'
import { AuthorizersConstruct } from './constructs/authorizers'
// 8-07 Secrets KMS imports — [Engineer-Principal · Opus · run-round8-07-secrets-kms]
import { SecretsConstruct, SecretRef, secretName } from './constructs/secrets'
import { PerTenantKmsConstruct } from './constructs/per-tenant-kms'
import { KeyRotationLambdaConstruct } from './constructs/key-rotation-lambda'

/**
 * Per-environment configuration — loaded from cdk.json context key "envs".
 */
export interface EnvConfig {
  readonly account: string
  readonly region: string
  readonly domain: string
  readonly auroraMinAcu: number
  readonly auroraMaxAcu: number
  readonly logRetentionDays: number
  readonly enableMfa: boolean
}

export interface OrbitalHubStackProps extends cdk.StackProps {
  readonly envName: 'mwitt' | 'rreed' | 'prod'
  readonly envConfig: EnvConfig
}

/**
 * OrbitalHubStack — the single CDK stack for one Orbital environment.
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
   * Cognito construct — exposes userPool, appClient, userPoolDomain.
   */
  readonly cognito: CognitoConstruct

  /**
   * DNS construct — exposes hostedZone and wildcard ACM certificate.
   */
  readonly dns: DnsConstruct

  // ------------------------------------------------------------------
  // Round 8-02 Aurora — [Engineer-Sr · Sonnet · run-round8-02-aurora]
  // ------------------------------------------------------------------
  /**
   * Aurora Serverless v2 construct — exposes cluster, securityGroup, masterSecret.
   */
  readonly aurora: AuroraConstruct

  /**
   * RDS Proxy construct — exposes proxy, proxySecurityGroup, lambdaSecurityGroup.
   */
  readonly rdsProxy: RdsProxyConstruct

  // 8-06 S3 — static UI + replay bucket constructs
  /**
   * Static UI construct — S3 bucket + CloudFront distribution.
   * [Engineer-Sr · Sonnet · run-round8-06-s3-cloudfront]
   */
  readonly staticUi: StaticUiConstruct

  /**
   * Replay bucket construct — SSE-KMS encrypted S3 bucket for replay blobs.
   * [Engineer-Sr · Sonnet · run-round8-06-s3-cloudfront]
   */
  readonly replayBucket: ReplayBucketConstruct

  // ------------------------------------------------------------------
  // Round 8-03 Lambda HTTP — [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
  // ------------------------------------------------------------------
  /**
   * Map of router group → Lambda construct.
   * All 11 tRPC router groups are created here.
   */
  readonly lambdas: Map<RouterGroup, LambdaTrpcConstruct>

  /**
   * Authorizers construct — Cognito JWT + PKI envelope authorizers.
   */
  readonly authorizersConstruct: AuthorizersConstruct

  /**
   * HTTP API Gateway construct — routes + custom domain + CORS.
   */
  readonly apiGw: ApiGwHttpConstruct

  // ------------------------------------------------------------------
  // 8-07 Secrets KMS — [Engineer-Principal · Opus · run-round8-07-secrets-kms]
  // ------------------------------------------------------------------
  /**
   * SecretsConstruct — env-level Secrets Manager secrets + KMS CMK.
   */
  readonly secrets: SecretsConstruct

  /**
   * PerTenantKmsConstruct — IAM scaffolding for runtime per-tenant CMKs.
   * No CMKs are created at deploy time; runtime creation by onboarding Lambda.
   */
  readonly perTenantKms: PerTenantKmsConstruct

  /**
   * KeyRotationLambdaConstruct — rotates the hub master Ed25519 key every 90d.
   */
  readonly keyRotation: KeyRotationLambdaConstruct

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
      description: `Orbital Hub — ${props.envName} environment (8-01: VPC + Cognito + DNS)`,
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
    // ------------------------------------------------------------------
    this.dns = new DnsConstruct(this, 'Dns', {
      domain: props.envConfig.domain,
      envName: props.envName,
    })

    // ------------------------------------------------------------------
    // Cognito
    // ------------------------------------------------------------------
    this.cognito = new CognitoConstruct(this, 'Cognito', {
      envName: props.envName,
      enableMfa: props.envConfig.enableMfa,
      domain: props.envConfig.domain,
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
      description: `Orbital ${props.envName} — RDS Proxy SG (forward ref for Aurora). Managed by RdsProxyConstruct.`,
      allowAllOutbound: false,
    })

    // Aurora construct — receives the proxy SG as its allowedSg
    this.aurora = new AuroraConstruct(this, 'Aurora', {
      envName: props.envName,
      vpc: this.vpc,
      minAcu: props.envConfig.auroraMinAcu,
      maxAcu: props.envConfig.auroraMaxAcu,
      logRetentionDays: props.envConfig.logRetentionDays,
      allowedSg: proxySgForAurora,
    })

    // RDS Proxy construct — creates Lambda SG, proxy SG (imports proxySgForAurora
    // by reference), and the DatabaseProxy resource fronting Aurora.
    this.rdsProxy = new RdsProxyConstruct(this, 'RdsProxy', {
      envName: props.envName,
      vpc: this.vpc,
      cluster: this.aurora.cluster,
      masterSecret: this.aurora.masterSecret,
      existingProxySg: proxySgForAurora,
    })

    // Migration runner trigger — invokes on every cdk deploy
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
    // 8-06 S3 — Static UI bucket + CloudFront + Replay bucket
    // [Engineer-Sr · Sonnet · run-round8-06-s3-cloudfront]
    // ------------------------------------------------------------------
    this.staticUi = new StaticUiConstruct(this, 'StaticUi', {
      envName: props.envName,
      domain: props.envConfig.domain,
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
    // 8-03 Lambda HTTP — Lambda functions + API Gateway + Authorizers
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

    // One Lambda per router group
    const allRouterGroups: RouterGroup[] = [
      'auth',
      'tasks',
      'memory',
      'comms',
      'defects',
      'audit',
      'prs',
      'cost',
      'providers',
      'team',
      'onboarding',
    ]

    this.lambdas = new Map<RouterGroup, LambdaTrpcConstruct>()

    for (const group of allRouterGroups) {
      const construct = new LambdaTrpcConstruct(this, `Lambda-${group}`, {
        routerGroup: group,
        envName: props.envName,
        vpc: this.vpc,
        lambdaSg: this.rdsProxy.lambdaSecurityGroup,
        rdsProxy: this.rdsProxy.proxy,
        // Secret ARNs — 8-07 will populate; placeholder empty map for now.
        // 8-07 will extend by calling role.addToPolicy on each Lambda's role.
        secretArns: {},
        proxyEndpoint: this.rdsProxy.proxy.endpoint,
        logRetentionDays: props.envConfig.logRetentionDays,
        cognitoUserPoolId: this.cognito.userPool.userPoolId,
        cognitoAppClientId: this.cognito.appClient.userPoolClientId,
        region: props.envConfig.region,
        // Replay bucket for audit Lambda (reads replay blobs)
        replayBucket: group === 'audit' ? this.replayBucket.bucket : undefined,
      })
      this.lambdas.set(group, construct)
    }

    // API Gateway HTTP — routes wired to each Lambda
    const routeConfigs = [
      // Browser-facing routes (Cognito authorizer)
      { routeKey: 'ANY /trpc/auth/{proxy+}', group: 'auth' as RouterGroup, authType: 'cognito' as const },
      { routeKey: 'ANY /trpc/tasks/{proxy+}', group: 'tasks' as RouterGroup, authType: 'cognito' as const },
      { routeKey: 'ANY /trpc/memory/{proxy+}', group: 'memory' as RouterGroup, authType: 'cognito' as const },
      { routeKey: 'ANY /trpc/comms/{proxy+}', group: 'comms' as RouterGroup, authType: 'cognito' as const },
      { routeKey: 'ANY /trpc/defects/{proxy+}', group: 'defects' as RouterGroup, authType: 'cognito' as const },
      { routeKey: 'ANY /trpc/audit/{proxy+}', group: 'audit' as RouterGroup, authType: 'cognito' as const },
      { routeKey: 'ANY /trpc/prs/{proxy+}', group: 'prs' as RouterGroup, authType: 'cognito' as const },
      { routeKey: 'ANY /trpc/cost/{proxy+}', group: 'cost' as RouterGroup, authType: 'cognito' as const },
      { routeKey: 'ANY /trpc/providers/{proxy+}', group: 'providers' as RouterGroup, authType: 'cognito' as const },
      { routeKey: 'ANY /trpc/team/{proxy+}', group: 'team' as RouterGroup, authType: 'cognito' as const },
      { routeKey: 'ANY /trpc/onboarding/{proxy+}', group: 'onboarding' as RouterGroup, authType: 'cognito' as const },
      // Install-to-hub routes (PKI envelope authorizer)
      // Local Orbital installs use tasks Lambda for work claiming + event append
      { routeKey: 'ANY /install/{proxy+}', group: 'tasks' as RouterGroup, authType: 'install' as const },
    ]

    this.apiGw = new ApiGwHttpConstruct(this, 'ApiGw', {
      envName: props.envName,
      domain: props.envConfig.domain,
      certificate: this.dns.certificate,
      hostedZone: this.dns.hostedZone,
      cognitoAuthorizer: this.authorizersConstruct.cognitoAuthorizer,
      installAuthorizer: this.authorizersConstruct.installAuthorizer,
      routes: routeConfigs.map(({ routeKey, group, authType }) => ({
        routeKey,
        fn: this.lambdas.get(group)!.fn,
        authType,
      })),
      logRetentionDays: props.envConfig.logRetentionDays,
    })

    // ------------------------------------------------------------------
    // (end Round 8-03 Lambda HTTP)
    // ------------------------------------------------------------------

    // ------------------------------------------------------------------
    // 8-07 Secrets KMS — Secrets Manager + KMS + per-tenant CMK IAM + rotation
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

    // Per-Lambda IAM scoping — tight grants, principle of least privilege.
    //
    // Each Lambda group declares the minimum set of secrets it must access.
    // Wrong scoping = secret leak across boundaries — covered by IAM scoping
    // tests in secrets.test.ts.
    const lambdaSecretGrants: Record<RouterGroup, SecretRef[]> = {
      // auth: needs hub master key (sign envelopes for hub-to-install) +
      // db creds (Aurora connection via RDS Proxy IAM auth — but we still
      // need the master secret for username lookup).
      auth: ['dbMasterCreds', 'hubMasterKey'],
      // tasks: install→hub envelope verification + DB.
      tasks: ['dbMasterCreds', 'hubMasterKey'],
      // memory: DB only.
      memory: ['dbMasterCreds'],
      // comms: DB only.
      comms: ['dbMasterCreds'],
      // defects: DB only.
      defects: ['dbMasterCreds'],
      // audit: DB + per-tenant KMS usage (read replay blobs).
      audit: ['dbMasterCreds'],
      // prs: DB + GitHub webhook secret (HMAC verification).
      prs: ['dbMasterCreds', 'githubWebhookSecret'],
      // cost: DB only.
      cost: ['dbMasterCreds'],
      // providers: DB only.
      providers: ['dbMasterCreds'],
      // team: DB only.
      team: ['dbMasterCreds'],
      // onboarding: DB + per-tenant KMS create/usage (provisions tenant CMK).
      onboarding: ['dbMasterCreds'],
    }

    for (const [group, refs] of Object.entries(lambdaSecretGrants) as [RouterGroup, SecretRef[]][]) {
      const lambda = this.lambdas.get(group)
      if (!lambda) continue
      this.secrets.grantReadFor(lambda.role, refs)

      // Inject the secret ARNs into Lambda env so the runtime can call
      // GetSecretValue without hard-coding ARNs in code.
      for (const ref of refs) {
        const envVar = secretEnvVarName(ref)
        lambda.fn.addEnvironment(envVar, secretArnFor(this.secrets, ref))
      }
      // Also export the secret name (some clients prefer name to ARN).
      for (const ref of refs) {
        lambda.fn.addEnvironment(secretNameEnvVar(ref), secretName(props.envName, ref))
      }
    }

    // Per-tenant KMS grants:
    //   - audit Lambda: USE per-tenant CMKs (decrypt replay blobs)
    //   - onboarding Lambda: CREATE per-tenant CMKs + USE
    const auditLambda = this.lambdas.get('audit')
    if (auditLambda) {
      this.perTenantKms.grantPerTenantUsage(auditLambda.role)
    }
    const onboardingLambda = this.lambdas.get('onboarding')
    if (onboardingLambda) {
      this.perTenantKms.grantOnboardingPermissions(onboardingLambda.role)
      this.perTenantKms.grantPerTenantUsage(onboardingLambda.role)
      // The admin Lambda (if any) should hold deletion rights for tenant
      // offboarding. We grant deletion to the onboarding Lambda since that's
      // where the offboarding handler lives in the orchestrator.
      this.perTenantKms.grantTenantDeletion(onboardingLambda.role)
    }

    // ------------------------------------------------------------------
    // (end 8-07 Secrets KMS)
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

    // Tag everything in this stack for cost allocation and filtering
    cdk.Tags.of(this).add('orbital:env', props.envName)
    cdk.Tags.of(this).add('orbital:stack', 'hub')
    cdk.Tags.of(this).add('orbital:managed-by', 'cdk')
  }
}

// ---------------------------------------------------------------------------
// 8-07 Secrets KMS — env-var name helpers
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
 * to ARN — some AWS SDK clients are happier with the name).
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
