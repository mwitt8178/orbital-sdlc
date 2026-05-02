// [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
import * as cdk from 'aws-cdk-lib'
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as route53targets from 'aws-cdk-lib/aws-route53-targets'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { Construct } from 'constructs'

/**
 * Route definition — one per logical group of tRPC routes.
 */
export interface RouteConfig {
  /**
   * HTTP route key, e.g. "ANY /trpc/tasks/{proxy+}" or "ANY /trpc/auth/{proxy+}".
   */
  readonly routeKey: string
  /**
   * Lambda function to integrate with.
   */
  readonly fn: lambda.Function
  /**
   * Which authorizer to use on this route.
   * - 'cognito': HTTP JWT authorizer (Cognito user pool) — browser traffic
   * - 'install': Custom Lambda authorizer (PKI envelope) — install traffic
   * - 'none': no authorizer (public — e.g. health check)
   */
  readonly authType: 'cognito' | 'install' | 'none'
}

export interface ApiGwHttpProps {
  /**
   * Environment name — used in naming and CORS origin.
   */
  readonly envName: string
  /**
   * Base domain for the environment, e.g. "mwitt.orbital.team.dev".
   * API domain will be api.{domain}.
   */
  readonly domain: string
  /**
   * ACM certificate for the custom domain (wildcard cert from DnsConstruct).
   */
  readonly certificate: acm.ICertificate
  /**
   * Route 53 hosted zone for the api.{domain} A-record.
   */
  readonly hostedZone: route53.IHostedZone
  /**
   * Cognito JWT authorizer — points at the Cognito issuer.
   */
  readonly cognitoAuthorizer: apigatewayv2.IHttpRouteAuthorizer
  /**
   * Install Lambda authorizer — verifies PKI envelope.
   */
  readonly installAuthorizer: apigatewayv2.IHttpRouteAuthorizer
  /**
   * Route configurations to wire. Each becomes an API GW route + integration.
   */
  readonly routes: RouteConfig[]
  /**
   * CloudWatch log retention in days.
   */
  readonly logRetentionDays: number
  /**
   * Default throttle: max requests per second.
   * Default: 100 req/sec per route.
   */
  readonly defaultThrottleRateLimit?: number
  /**
   * Default throttle: max burst (token bucket depth).
   * Default: 200.
   */
  readonly defaultThrottleBurstLimit?: number
}

/**
 * ApiGwHttpConstruct — HTTP API Gateway for the Orbital tRPC Hub.
 *
 * Features:
 *  - HTTP API (not REST API) — lower latency, native Lambda proxy integration
 *  - Custom domain: api.{domain}
 *  - CORS: allows https://{domain} + localhost:3000 for dev
 *  - Default throttle: 100 req/sec per route, 200 burst
 *  - Structured access logging to CloudWatch
 *  - Route-level authorizer selection (Cognito vs PKI vs none)
 *  - Single default stage ($default) with auto-deploy
 *
 * Route mapping convention (matches handler groups from LambdaTrpcConstruct):
 *   ANY /trpc/auth/{proxy+}       → auth Lambda    + Cognito authorizer
 *   ANY /trpc/tasks/{proxy+}      → tasks Lambda   + Cognito authorizer
 *   ANY /trpc/memory/{proxy+}     → memory Lambda  + Cognito authorizer
 *   ANY /trpc/comms/{proxy+}      → comms Lambda   + Cognito authorizer
 *   ANY /trpc/defects/{proxy+}    → defects Lambda + Cognito authorizer
 *   ANY /trpc/audit/{proxy+}      → audit Lambda   + Cognito authorizer
 *   ANY /trpc/prs/{proxy+}        → prs Lambda     + Cognito authorizer
 *   ANY /trpc/cost/{proxy+}       → cost Lambda    + Cognito authorizer
 *   ANY /trpc/providers/{proxy+}  → providers Lambda + Cognito authorizer
 *   ANY /trpc/team/{proxy+}       → team Lambda    + Cognito authorizer
 *   ANY /trpc/onboarding/{proxy+} → onboarding Lambda + Cognito authorizer
 *   ANY /install/{proxy+}         → tasks Lambda   + install authorizer
 *   GET /health                   → (inline) no authorizer
 */
export class ApiGwHttpConstruct extends Construct {
  /**
   * The HTTP API resource.
   */
  readonly api: apigatewayv2.HttpApi

  /**
   * The custom domain name resource.
   */
  readonly customDomain: apigatewayv2.DomainName

  constructor(scope: Construct, id: string, props: ApiGwHttpProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'
    const apiDomain = `api.${props.domain}`
    const throttleRateLimit = props.defaultThrottleRateLimit ?? 100
    const throttleBurstLimit = props.defaultThrottleBurstLimit ?? 200

    // ------------------------------------------------------------------
    // Access log group
    // ------------------------------------------------------------------
    const accessLogGroup = new logs.LogGroup(this, 'AccessLogs', {
      logGroupName: `/orbital/${props.envName}/apigateway/http-api-access-logs`,
      retention: props.logRetentionDays as logs.RetentionDays,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    // ------------------------------------------------------------------
    // Custom domain
    // ------------------------------------------------------------------
    this.customDomain = new apigatewayv2.DomainName(this, 'CustomDomain', {
      domainName: apiDomain,
      certificate: props.certificate,
    })

    // ------------------------------------------------------------------
    // HTTP API
    // ------------------------------------------------------------------
    this.api = new apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: `orbital-${props.envName}-api`,
      description: `Orbital ${props.envName} tRPC HTTP API`,

      // CORS configuration
      corsPreflight: {
        allowOrigins: [
          `https://${props.domain}`,
          // Allow localhost for local dev against the cloud API
          'http://localhost:3000',
          'http://localhost:5173',
        ],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.OPTIONS,
        ],
        allowHeaders: [
          'Content-Type',
          'Authorization',
          // PKI envelope headers
          'X-Orbital-Install-Id',
          'X-Orbital-Sig',
          'X-Orbital-Sig-Body',
          'X-Orbital-Tenant-ID',
        ],
        allowCredentials: true,
        maxAge: cdk.Duration.hours(1),
      },

      // Default stage with auto-deploy
      defaultDomainMapping: {
        domainName: this.customDomain,
      },

      // Disable execute-api endpoint in prod (force custom domain)
      disableExecuteApiEndpoint: isProd,
    })

    // ------------------------------------------------------------------
    // Stage throttling — default stage ($default) is created automatically;
    // we configure it via CfnStage override.
    // ------------------------------------------------------------------
    const cfnStage = this.api.defaultStage?.node.defaultChild as
      | apigatewayv2.CfnStage
      | undefined

    if (cfnStage) {
      cfnStage.addPropertyOverride('DefaultRouteSettings', {
        ThrottlingRateLimit: throttleRateLimit,
        ThrottlingBurstLimit: throttleBurstLimit,
        DetailedMetricsEnabled: true,
        LoggingLevel: 'INFO',
        DataTraceEnabled: false, // avoid logging request bodies (may contain PII)
      })

      cfnStage.addPropertyOverride('AccessLogSettings', {
        DestinationArn: accessLogGroup.logGroupArn,
        Format: JSON.stringify({
          requestId: '$context.requestId',
          routeKey: '$context.routeKey',
          status: '$context.status',
          protocol: '$context.protocol',
          requestTime: '$context.requestTime',
          responseLength: '$context.responseLength',
          integrationLatency: '$context.integrationLatency',
          responseLatency: '$context.responseLatency',
          errorMessage: '$context.error.message',
          errorType: '$context.error.responseType',
          tenantId: '$context.authorizer.tenantId',
          installId: '$context.authorizer.installId',
          userId: '$context.authorizer.userId',
        }),
      })
    }

    // ------------------------------------------------------------------
    // Wire routes
    // ------------------------------------------------------------------
    for (const routeCfg of props.routes) {
      const integration = new integrations.HttpLambdaIntegration(
        `Integration-${sanitizeId(routeCfg.routeKey)}`,
        routeCfg.fn,
        {
          payloadFormatVersion:
            apigatewayv2.PayloadFormatVersion.VERSION_2_0,
          timeout: cdk.Duration.seconds(29),
        },
      )

      const authorizerForRoute: apigatewayv2.IHttpRouteAuthorizer | undefined =
        routeCfg.authType === 'cognito'
          ? props.cognitoAuthorizer
          : routeCfg.authType === 'install'
          ? props.installAuthorizer
          : undefined // 'none' — no authorizer (e.g. health check)

      this.api.addRoutes({
        path: parseRoutePath(routeCfg.routeKey),
        methods: parseMethods(routeCfg.routeKey),
        integration,
        ...(authorizerForRoute !== undefined ? { authorizer: authorizerForRoute } : {}),
      })
    }

    // ------------------------------------------------------------------
    // Route 53 A-record: api.{domain} → API GW custom domain
    // ------------------------------------------------------------------
    new route53.ARecord(this, 'ApiDnsRecord', {
      zone: props.hostedZone,
      recordName: `api.${props.domain}`,
      target: route53.RecordTarget.fromAlias(
        new route53targets.ApiGatewayv2DomainProperties(
          this.customDomain.regionalDomainName,
          this.customDomain.regionalHostedZoneId,
        ),
      ),
      comment: `Orbital ${props.envName} — HTTP API custom domain`,
    })

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'HttpApiId', {
      value: this.api.apiId,
      description: `Orbital ${props.envName} HTTP API ID`,
      exportName: `OrbitalHub-${props.envName}-HttpApiId`,
    })

    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: `https://${apiDomain}`,
      description: `Orbital ${props.envName} API endpoint (custom domain)`,
      exportName: `OrbitalHub-${props.envName}-ApiEndpoint`,
    })

    cdk.Tags.of(this).add('orbital:component', 'api-gateway-http')
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a route key for use as a CDK construct ID.
 * "ANY /trpc/tasks/{proxy+}" → "ANYtrpctasksproxy"
 */
function sanitizeId(routeKey: string): string {
  return routeKey.replace(/[^a-zA-Z0-9]/g, '')
}

/**
 * Extract the path portion from a route key.
 * "ANY /trpc/tasks/{proxy+}" → "/trpc/tasks/{proxy+}"
 */
function parseRoutePath(routeKey: string): string {
  const parts = routeKey.split(' ')
  return parts[1] ?? routeKey
}

/**
 * Extract HTTP methods from a route key.
 * "ANY /..." → [HttpMethod.ANY]
 * "GET /..." → [HttpMethod.GET]
 */
function parseMethods(routeKey: string): apigatewayv2.HttpMethod[] {
  const verb = routeKey.split(' ')[0] ?? 'ANY'
  switch (verb.toUpperCase()) {
    case 'GET':
      return [apigatewayv2.HttpMethod.GET]
    case 'POST':
      return [apigatewayv2.HttpMethod.POST]
    case 'PUT':
      return [apigatewayv2.HttpMethod.PUT]
    case 'DELETE':
      return [apigatewayv2.HttpMethod.DELETE]
    case 'PATCH':
      return [apigatewayv2.HttpMethod.PATCH]
    case 'ANY':
    default:
      return [apigatewayv2.HttpMethod.ANY]
  }
}
