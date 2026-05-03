// [Engineer-Sr · Sonnet · run-round8-04-websocket-api]
import * as cdk from 'aws-cdk-lib'
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as route53targets from 'aws-cdk-lib/aws-route53-targets'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { Construct } from 'constructs'

export interface ApiGwWsProps {
  /**
   * Environment name - used in naming and resource descriptions.
   */
  readonly envName: string
  /**
   * Base domain for the environment, e.g. "mwitt.orbital.team.dev".
   * WS domain will be ws.{domain} when useCustomDomain=true.
   */
  readonly domain: string
  /**
   * ACM wildcard certificate for ws.{domain} (from DnsConstruct).
   * When undefined (useCustomDomain=false), no custom domain is created and
   * the WS API uses the AWS-generated execute-api endpoint.
   */
  readonly certificate: acm.ICertificate | undefined
  /**
   * Route 53 hosted zone for the ws.{domain} A-record.
   * When undefined (useCustomDomain=false), no Route 53 record is created.
   */
  readonly hostedZone: route53.IHostedZone | undefined
  /**
   * Lambda for $connect route - validates auth, writes DynamoDB row.
   */
  readonly connectFn: lambda.Function
  /**
   * Lambda for $disconnect route - removes DynamoDB row.
   */
  readonly disconnectFn: lambda.Function
  /**
   * Lambda for $default route - handles subscribe/unsubscribe/ping messages.
   */
  readonly defaultFn: lambda.Function
  /**
   * CloudWatch log retention days.
   */
  readonly logRetentionDays: number
}

/**
 * ApiGwWsConstruct - API Gateway WebSocket API for Orbital real-time push.
 *
 * Features:
 *  - WebSocket API (not HTTP API)
 *  - Three routes: $connect, $disconnect, $default (all Lambda proxy)
 *  - Custom domain: ws.{domain}
 *  - Access logging to CloudWatch
 *  - Route 53 A-record for ws.{domain}
 *  - Management API endpoint exposed for fanout Lambda (postToConnection)
 *
 * Auth strategy:
 *  - Cognito JWT passed as query-string param `token` (browsers cannot set
 *    custom headers on WebSocket upgrades)
 *  - PKI envelope passed as query-string params `install_id`, `sig`, `sig_body`
 *  - $connect Lambda validates and writes the connection row
 *  - No separate $connect Lambda authorizer (combined auth in connect handler
 *    for simplicity; the handler returns 401 on failure which closes the WS)
 *
 * Management API:
 *  - mgmtEndpoint exposed as `managementApiEndpoint` property
 *  - Fanout Lambda uses this to call postToConnection
 */
export class ApiGwWsConstruct extends Construct {
  /**
   * The WebSocket API resource.
   */
  readonly api: apigatewayv2.CfnApi

  /**
   * Custom domain name for ws.{domain}.
   * Undefined when useCustomDomain=false (no certificate/hostedZone provided).
   */
  readonly customDomain: apigatewayv2.CfnDomainName | undefined

  /**
   * WebSocket stage - used for the deployment ARN.
   */
  readonly stage: apigatewayv2.CfnStage

  /**
   * Management API endpoint URL for postToConnection calls.
   * Format: https://{api-id}.execute-api.{region}.amazonaws.com/{stage}
   */
  readonly managementApiEndpoint: string

  /**
   * API ID - used by fanout Lambda to construct the management API client.
   */
  readonly apiId: string

  /**
   * Stage name - '$default' - exposed for fanout Lambda env var.
   */
  readonly stageName: string

  constructor(scope: Construct, id: string, props: ApiGwWsProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'
    const wsDomain = `ws.${props.domain}`
    this.stageName = '$default'

    // ------------------------------------------------------------------
    // Access log group
    // ------------------------------------------------------------------
    const accessLogGroup = new logs.LogGroup(this, 'AccessLogs', {
      logGroupName: `/orbital/${props.envName}/apigateway/ws-api-access-logs`,
      retention: props.logRetentionDays as logs.RetentionDays,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    // ------------------------------------------------------------------
    // WebSocket API (L1 - apigatewayv2 L2 does not yet support WS APIs)
    // ------------------------------------------------------------------
    this.api = new apigatewayv2.CfnApi(this, 'WebSocketApi', {
      name: `orbital-${props.envName}-ws`,
      protocolType: 'WEBSOCKET',
      // Route selection expression: reads the "action" key from message body
      routeSelectionExpression: '$request.body.action',
      description: `Orbital ${props.envName} WebSocket API`,
    })

    this.apiId = this.api.ref

    // ------------------------------------------------------------------
    // Lambda integrations
    // ------------------------------------------------------------------
    const connectIntegration = new apigatewayv2.CfnIntegration(this, 'ConnectIntegration', {
      apiId: this.api.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:${cdk.Stack.of(this).partition}:apigateway:${cdk.Stack.of(this).region}:lambda:path/2015-03-31/functions/${ props.connectFn.functionArn }/invocations`,
      integrationMethod: 'POST',
    })

    const disconnectIntegration = new apigatewayv2.CfnIntegration(this, 'DisconnectIntegration', {
      apiId: this.api.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:${cdk.Stack.of(this).partition}:apigateway:${cdk.Stack.of(this).region}:lambda:path/2015-03-31/functions/${ props.disconnectFn.functionArn }/invocations`,
      integrationMethod: 'POST',
    })

    const defaultIntegration = new apigatewayv2.CfnIntegration(this, 'DefaultIntegration', {
      apiId: this.api.ref,
      integrationType: 'AWS_PROXY',
      integrationUri: `arn:${cdk.Stack.of(this).partition}:apigateway:${cdk.Stack.of(this).region}:lambda:path/2015-03-31/functions/${ props.defaultFn.functionArn }/invocations`,
      integrationMethod: 'POST',
    })

    // ------------------------------------------------------------------
    // Routes: $connect, $disconnect, $default
    // ------------------------------------------------------------------
    const connectRoute = new apigatewayv2.CfnRoute(this, 'ConnectRoute', {
      apiId: this.api.ref,
      routeKey: '$connect',
      authorizationType: 'NONE',
      target: `integrations/${connectIntegration.ref}`,
    })

    const disconnectRoute = new apigatewayv2.CfnRoute(this, 'DisconnectRoute', {
      apiId: this.api.ref,
      routeKey: '$disconnect',
      authorizationType: 'NONE',
      target: `integrations/${disconnectIntegration.ref}`,
    })

    const defaultRoute = new apigatewayv2.CfnRoute(this, 'DefaultRoute', {
      apiId: this.api.ref,
      routeKey: '$default',
      authorizationType: 'NONE',
      target: `integrations/${defaultIntegration.ref}`,
    })

    // ------------------------------------------------------------------
    // Deployment + Stage
    // ------------------------------------------------------------------
    const deployment = new apigatewayv2.CfnDeployment(this, 'Deployment', {
      apiId: this.api.ref,
    })

    // Deployment depends on routes being created first
    deployment.addDependency(connectRoute)
    deployment.addDependency(disconnectRoute)
    deployment.addDependency(defaultRoute)

    this.stage = new apigatewayv2.CfnStage(this, 'Stage', {
      apiId: this.api.ref,
      stageName: this.stageName,
      autoDeploy: true,
      deploymentId: deployment.ref,
      accessLogSettings: {
        destinationArn: accessLogGroup.logGroupArn,
        format: JSON.stringify({
          requestId: '$context.requestId',
          connectionId: '$context.connectionId',
          routeKey: '$context.routeKey',
          status: '$context.status',
          requestTime: '$context.requestTime',
          integrationLatency: '$context.integrationLatency',
          errorMessage: '$context.error.message',
          errorType: '$context.error.responseType',
        }),
      },
      defaultRouteSettings: {
        loggingLevel: 'INFO',
        dataTraceEnabled: false,
        detailedMetricsEnabled: true,
        throttlingRateLimit: 100,
        throttlingBurstLimit: 200,
      },
    })

    // ------------------------------------------------------------------
    // Lambda permissions - allow API GW to invoke each Lambda
    // ------------------------------------------------------------------
    const apiArn = `arn:aws:execute-api:${cdk.Stack.of(this).region}:${cdk.Stack.of(this).account}:${this.api.ref}`

    props.connectFn.addPermission('AllowApiGwConnect', {
      principal: new cdk.aws_iam.ServicePrincipal('apigateway.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: `${apiArn}/*/$connect`,
    })

    props.disconnectFn.addPermission('AllowApiGwDisconnect', {
      principal: new cdk.aws_iam.ServicePrincipal('apigateway.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: `${apiArn}/*/$disconnect`,
    })

    props.defaultFn.addPermission('AllowApiGwDefault', {
      principal: new cdk.aws_iam.ServicePrincipal('apigateway.amazonaws.com'),
      action: 'lambda:InvokeFunction',
      sourceArn: `${apiArn}/*/*`,
    })

    // ------------------------------------------------------------------
    // Management API endpoint (used by fanout Lambda for postToConnection)
    // This follows the standard API GW WS management endpoint format.
    // ------------------------------------------------------------------
    this.managementApiEndpoint = `https://${this.api.ref}.execute-api.${cdk.Stack.of(this).region}.amazonaws.com/${this.stageName}`

    // ------------------------------------------------------------------
    // Custom domain: ws.{domain}
    // Only created when certificate + hostedZone are provided.
    // ------------------------------------------------------------------
    const useCustomDomain = props.certificate !== undefined && props.hostedZone !== undefined

    if (useCustomDomain) {
      this.customDomain = new apigatewayv2.CfnDomainName(this, 'WsDomainName', {
        domainName: wsDomain,
        domainNameConfigurations: [
          {
            certificateArn: props.certificate!.certificateArn,
            endpointType: 'REGIONAL',
            securityPolicy: 'TLS_1_2',
          },
        ],
      })

      // API mapping: ws.{domain} → this API / $default stage
      new apigatewayv2.CfnApiMapping(this, 'WsApiMapping', {
        apiId: this.api.ref,
        domainName: this.customDomain.ref,
        stage: this.stage.ref,
      })

      // Route 53 A-record: ws.{domain} → API GW regional domain
      new route53.CfnRecordSet(this, 'WsDnsRecord', {
        hostedZoneId: props.hostedZone!.hostedZoneId,
        name: `${wsDomain}.`,
        type: 'A',
        aliasTarget: {
          dnsName: this.customDomain.attrRegionalDomainName,
          hostedZoneId: this.customDomain.attrRegionalHostedZoneId,
          evaluateTargetHealth: false,
        },
      })
    } else {
      this.customDomain = undefined
    }

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'WsApiId', {
      value: this.api.ref,
      description: `Orbital ${props.envName} WebSocket API ID`,
      exportName: `OrbitalHub-${props.envName}-WsApiId`,
    })

    // WsEndpoint: custom domain URL when available, otherwise execute-api WSS URL
    const wsEndpointValue = useCustomDomain
      ? `wss://${wsDomain}`
      : `wss://${this.api.ref}.execute-api.${cdk.Stack.of(this).region}.amazonaws.com/${this.stageName}`

    new cdk.CfnOutput(this, 'WsEndpoint', {
      value: wsEndpointValue,
      description: `Orbital ${props.envName} WebSocket endpoint`,
      exportName: `OrbitalHub-${props.envName}-WsEndpoint`,
    })

    new cdk.CfnOutput(this, 'WsMgmtEndpoint', {
      value: this.managementApiEndpoint,
      description: `Orbital ${props.envName} WebSocket Management API endpoint (for postToConnection)`,
      exportName: `OrbitalHub-${props.envName}-WsMgmtEndpoint`,
    })

    cdk.Tags.of(this).add('orbital:component', 'api-gateway-ws')
  }
}
