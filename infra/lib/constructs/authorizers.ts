// [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
import * as cdk from 'aws-cdk-lib'
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as authorizersLib from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import * as cognito from 'aws-cdk-lib/aws-cognito'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as path from 'path'
import { Construct } from 'constructs'

export interface AuthorizersConstructProps {
  /**
   * Environment name.
   */
  readonly envName: string

  // ------------------------------------------------------------------
  // Cognito JWT authorizer props
  // ------------------------------------------------------------------
  /**
   * Cognito user pool from 8-01's CognitoConstruct.
   * Used to derive the issuer URL and audience.
   */
  readonly userPool: cognito.IUserPool
  /**
   * Cognito app client ID (SPA client from 8-01).
   * Used as the JWT audience claim.
   */
  readonly appClientId: string
  /**
   * AWS region — needed to build the Cognito issuer URL.
   */
  readonly region: string

  // ------------------------------------------------------------------
  // Install Lambda authorizer props
  // ------------------------------------------------------------------
  /**
   * VPC for the install authorizer Lambda (reads Aurora for public key).
   */
  readonly vpc: ec2.IVpc
  /**
   * Lambda security group for the install authorizer function.
   */
  readonly lambdaSg: ec2.ISecurityGroup
  /**
   * RDS Proxy — install authorizer reads known_installs.public_key to verify.
   */
  readonly rdsProxy: rds.DatabaseProxy
  /**
   * RDS Proxy endpoint for DB connection.
   */
  readonly proxyEndpoint: string
  /**
   * CloudWatch log retention days.
   */
  readonly logRetentionDays: number
}

/**
 * AuthorizersConstruct — provisions both API Gateway HTTP authorizers.
 *
 * **cognito-auth**: HttpJwtAuthorizer
 *   - Validates Cognito access tokens via Cognito's JWKS endpoint
 *   - Issuer: https://cognito-idp.{region}.amazonaws.com/{userPoolId}
 *   - Audience: [appClientId]
 *   - Used for browser-initiated routes
 *
 * **install-auth**: HttpLambdaAuthorizer (custom)
 *   - Lambda function reads PKI envelope headers
 *   - Verifies Ed25519 signature against known_installs.public_key from Aurora
 *   - Returns {principalId, context: {installId, tenantId, role}}
 *   - Used for install-to-hub machine traffic
 *
 * Security notes:
 *  - JWT authorizer does NOT require scopes beyond "openid" in this config.
 *    Add scope requirements per-route when fine-grained scoping is needed.
 *  - Lambda authorizer result cache TTL = 0 (each request validated fresh).
 *    Cache is disabled because envelope nonces are single-use.
 *  - Install authorizer role is least-privilege: rds-db:connect only.
 */
export class AuthorizersConstruct extends Construct {
  /**
   * Cognito JWT authorizer — use on browser-facing routes.
   */
  readonly cognitoAuthorizer: apigatewayv2.IHttpRouteAuthorizer

  /**
   * PKI envelope Lambda authorizer — use on install-to-hub routes.
   */
  readonly installAuthorizer: apigatewayv2.IHttpRouteAuthorizer

  /**
   * The install authorizer Lambda function.
   * Exposed so callers can grant additional IAM permissions if needed.
   */
  readonly installAuthorizerFn: lambda.Function

  constructor(scope: Construct, id: string, props: AuthorizersConstructProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'

    // ------------------------------------------------------------------
    // 1. Cognito JWT authorizer
    //
    // HttpJwtAuthorizer validates the JWT inline at API GW (no Lambda needed).
    // The issuer URL follows the standard Cognito pattern.
    // ------------------------------------------------------------------
    const cognitoIssuer = `https://cognito-idp.${props.region}.amazonaws.com/${props.userPool.userPoolId}`

    this.cognitoAuthorizer = new authorizersLib.HttpJwtAuthorizer(
      'CognitoAuth',
      cognitoIssuer,
      {
        authorizerName: `orbital-${props.envName}-cognito-auth`,
        jwtAudience: [props.appClientId],
        identitySource: ['$request.header.Authorization'],
      },
    )

    // ------------------------------------------------------------------
    // 2. Install Lambda authorizer (PKI envelope)
    // ------------------------------------------------------------------

    // Log group for the install authorizer Lambda
    const authorizerLogGroup = new logs.LogGroup(this, 'InstallAuthLogGroup', {
      logGroupName: `/orbital/${props.envName}/lambda/install-authorizer`,
      retention: props.logRetentionDays as logs.RetentionDays,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    // IAM role — least-privilege: VPC execution + Aurora IAM auth
    const authorizerRole = new iam.Role(this, 'InstallAuthRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Orbital ${props.envName} install Lambda authorizer execution role`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName(
          'service-role/AWSLambdaVPCAccessExecutionRole',
        ),
      ],
    })

    // Grant RDS IAM auth (needed to query known_installs for public_key)
    props.rdsProxy.grantConnect(authorizerRole, 'orbital_admin')

    // X-Ray tracing
    authorizerRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
        resources: ['*'],
      }),
    )

    // The install authorizer Lambda code lives in the orchestrator package
    const orchestratorDist = path.resolve(
      __dirname,
      '../../../packages/orchestrator/dist',
    )

    this.installAuthorizerFn = new lambda.Function(this, 'InstallAuthFn', {
      functionName: `orbital-${props.envName}-install-authorizer`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'lambda/handlers/install-authorizer.handler',
      code: lambda.Code.fromAsset(orchestratorDist, {
        exclude: ['**/*.test.*', '**/*.spec.*', '**/test/**'],
      }),
      role: authorizerRole,
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [props.lambdaSg],
      timeout: cdk.Duration.seconds(10), // authorizer must complete quickly
      memorySize: 256,
      environment: {
        ORBITAL_DEPLOY_TARGET: 'aws',
        RDS_PROXY_HOSTNAME: props.proxyEndpoint,
        RDS_PROXY_PORT: '5432',
        AURORA_DB_NAME: 'orbital_hub',
        AURORA_USERNAME: 'orbital_admin',
        ORBITAL_ENV: props.envName,
      },
      logGroup: authorizerLogGroup,
      tracing: lambda.Tracing.ACTIVE,
    })

    // HTTP Lambda authorizer — simple (not IAM policy) response type
    // Cache TTL = 0 because envelope nonces are single-use; caching would
    // allow replay within the TTL window.
    this.installAuthorizer = new authorizersLib.HttpLambdaAuthorizer(
      'InstallAuth',
      this.installAuthorizerFn,
      {
        authorizerName: `orbital-${props.envName}-install-auth`,
        identitySource: [
          '$request.header.X-Orbital-Install-Id',
          '$request.header.X-Orbital-Sig',
          '$request.header.X-Orbital-Sig-Body',
        ],
        resultsCacheTtl: cdk.Duration.seconds(0), // no cache — nonces are single-use
        responseTypes: [authorizersLib.HttpLambdaResponseType.SIMPLE],
      },
    )

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'InstallAuthorizerArn', {
      value: this.installAuthorizerFn.functionArn,
      description: `Orbital ${props.envName} install Lambda authorizer ARN`,
      exportName: `OrbitalHub-${props.envName}-InstallAuthorizerArn`,
    })

    cdk.Tags.of(this).add('orbital:component', 'authorizers')
  }
}
