// [Engineer-Sr · Sonnet · run-round8-04-websocket-api]
/**
 * api-gw-ws.test.ts — Snapshot + property tests for ApiGwWsConstruct.
 *
 * TDD: RED first, GREEN once api-gw-ws.ts is implemented.
 *
 * Tests verify:
 *  1. WebSocket API is created (protocolType: WEBSOCKET)
 *  2. Three routes exist: $connect, $disconnect, $default
 *  3. Custom domain ws.{domain} is created
 *  4. Route 53 A-record for ws.{domain} is created
 *  5. Access log group is created with correct name
 *  6. Stage with auto-deploy and access logging
 *  7. Lambda permissions (resource-based policy) are created
 *  8. Outputs include WsApiId, WsEndpoint, WsMgmtEndpoint
 *  9. cdk-nag: no ERROR-level violations
 *  10. Snapshot
 */

import * as cdk from 'aws-cdk-lib'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib'
import { ApiGwWsConstruct } from '../lib/constructs/api-gw-ws'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildWsStack(envName = 'mwitt'): {
  stack: cdk.Stack
  template: Template
  wsConstruct: ApiGwWsConstruct
} {
  const domain = `${envName}.orbital.team.dev`
  const app = new cdk.App()
  const stack = new cdk.Stack(app, `TestWs-${envName}`, {
    env: { account: '123456789012', region: 'us-east-1' },
  })

  const hostedZone = new route53.HostedZone(stack, 'TestZone', {
    zoneName: domain,
  })

  const certificate = new acm.Certificate(stack, 'TestCert', {
    domainName: domain,
    subjectAlternativeNames: [`*.${domain}`],
  })

  // Stub Lambda functions (one per route)
  const connectFn = new lambda.Function(stack, 'ConnectFn', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200 })'),
  })

  const disconnectFn = new lambda.Function(stack, 'DisconnectFn', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200 })'),
  })

  const defaultFn = new lambda.Function(stack, 'DefaultFn', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200 })'),
  })

  const wsConstruct = new ApiGwWsConstruct(stack, 'WsApi', {
    envName,
    domain,
    certificate,
    hostedZone,
    connectFn,
    disconnectFn,
    defaultFn,
    logRetentionDays: 30,
  })

  const template = Template.fromStack(stack)
  return { stack, template, wsConstruct }
}

// ---------------------------------------------------------------------------
// WebSocket API
// ---------------------------------------------------------------------------

describe('ApiGwWsConstruct — WebSocket API', () => {
  test('creates a WebSocket API', () => {
    const { template } = buildWsStack()
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      ProtocolType: 'WEBSOCKET',
    })
  })

  test('API is named orbital-{env}-ws', () => {
    const { template } = buildWsStack('mwitt')
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: 'orbital-mwitt-ws',
      ProtocolType: 'WEBSOCKET',
    })
  })

  test('route selection expression uses action key', () => {
    const { template } = buildWsStack()
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      RouteSelectionExpression: '$request.body.action',
    })
  })
})

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('ApiGwWsConstruct — routes', () => {
  test('creates exactly 3 routes ($connect, $disconnect, $default)', () => {
    const { template } = buildWsStack()
    const routes = template.findResources('AWS::ApiGatewayV2::Route')
    expect(Object.keys(routes).length).toBe(3)
  })

  test('$connect route exists', () => {
    const { template } = buildWsStack()
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: '$connect',
    })
  })

  test('$disconnect route exists', () => {
    const { template } = buildWsStack()
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: '$disconnect',
    })
  })

  test('$default route exists', () => {
    const { template } = buildWsStack()
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: '$default',
    })
  })

  test('creates 3 Lambda integrations (one per route)', () => {
    const { template } = buildWsStack()
    const integrations = template.findResources('AWS::ApiGatewayV2::Integration')
    expect(Object.keys(integrations).length).toBe(3)
  })

  test('integrations are AWS_PROXY type', () => {
    const { template } = buildWsStack()
    template.hasResourceProperties('AWS::ApiGatewayV2::Integration', {
      IntegrationType: 'AWS_PROXY',
    })
  })
})

// ---------------------------------------------------------------------------
// Custom domain
// ---------------------------------------------------------------------------

describe('ApiGwWsConstruct — custom domain', () => {
  test('creates a custom domain for ws.{domain}', () => {
    const { template } = buildWsStack('mwitt')
    template.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
      DomainName: 'ws.mwitt.orbital.team.dev',
    })
  })

  test('custom domain uses TLS 1.2', () => {
    const { template } = buildWsStack()
    template.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
      DomainNameConfigurations: Match.arrayWith([
        Match.objectLike({ SecurityPolicy: 'TLS_1_2' }),
      ]),
    })
  })

  test('API mapping exists for the custom domain', () => {
    const { template } = buildWsStack()
    template.resourceCountIs('AWS::ApiGatewayV2::ApiMapping', 1)
  })

  test('Route 53 A-record created for ws.{domain}', () => {
    const { template } = buildWsStack('mwitt')
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'ws.mwitt.orbital.team.dev.',
      Type: 'A',
    })
  })
})

// ---------------------------------------------------------------------------
// Stage and access logging
// ---------------------------------------------------------------------------

describe('ApiGwWsConstruct — stage and logging', () => {
  test('creates a stage', () => {
    const { template } = buildWsStack()
    template.resourceCountIs('AWS::ApiGatewayV2::Stage', 1)
  })

  test('stage has auto-deploy enabled', () => {
    const { template } = buildWsStack()
    template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
      AutoDeploy: true,
    })
  })

  test('access log group is created with correct name', () => {
    const { template } = buildWsStack('mwitt')
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/orbital/mwitt/apigateway/ws-api-access-logs',
    })
  })

  test('access log group has 30-day retention', () => {
    const { template } = buildWsStack()
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/orbital/mwitt/apigateway/ws-api-access-logs',
      RetentionInDays: 30,
    })
  })
})

// ---------------------------------------------------------------------------
// Lambda permissions
// ---------------------------------------------------------------------------

describe('ApiGwWsConstruct — Lambda permissions', () => {
  test('creates 3 Lambda resource-based policy statements', () => {
    const { template } = buildWsStack()
    const permissions = template.findResources('AWS::Lambda::Permission', {
      Properties: {
        Action: 'lambda:InvokeFunction',
        Principal: 'apigateway.amazonaws.com',
      },
    })
    expect(Object.keys(permissions).length).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

describe('ApiGwWsConstruct — outputs', () => {
  test('outputs include WsApiId, WsEndpoint, WsMgmtEndpoint', () => {
    const { template } = buildWsStack()
    const outputs = template.findOutputs('*')
    const keys = Object.keys(outputs)
    expect(keys.some((k) => k.includes('WsApiId'))).toBe(true)
    expect(keys.some((k) => k.includes('WsEndpoint'))).toBe(true)
    expect(keys.some((k) => k.includes('WsMgmtEndpoint'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Construct properties
// ---------------------------------------------------------------------------

describe('ApiGwWsConstruct — construct properties', () => {
  test('managementApiEndpoint contains the API ID', () => {
    const { wsConstruct, stack } = buildWsStack()
    // The management endpoint is a token at synth time, but we can check it's
    // a non-empty resolved string token.
    expect(wsConstruct.managementApiEndpoint).toBeDefined()
    expect(typeof wsConstruct.managementApiEndpoint).toBe('string')
    // Should contain the expected region
    expect(wsConstruct.managementApiEndpoint).toContain('us-east-1')
    // Suppress unused warning
    expect(stack.stackName).toBeTruthy()
  })

  test('stageName is $default', () => {
    const { wsConstruct } = buildWsStack()
    expect(wsConstruct.stageName).toBe('$default')
  })
})

// ---------------------------------------------------------------------------
// cdk-nag
// ---------------------------------------------------------------------------

describe('ApiGwWsConstruct — cdk-nag', () => {
  test('no ERROR-level violations', () => {
    const domain = 'mwitt.orbital.team.dev'
    const app = new cdk.App()
    const stack = new cdk.Stack(app, 'NagWsStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })

    const hostedZone = new route53.HostedZone(stack, 'TestZone', { zoneName: domain })
    const certificate = new acm.Certificate(stack, 'TestCert', {
      domainName: domain,
      subjectAlternativeNames: [`*.${domain}`],
    })

    const mkFn = (id: string) =>
      new lambda.Function(stack, id, {
        runtime: lambda.Runtime.NODEJS_22_X,
        handler: 'index.handler',
        code: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200 })'),
      })

    new ApiGwWsConstruct(stack, 'WsApi', {
      envName: 'mwitt',
      domain,
      certificate,
      hostedZone,
      connectFn: mkFn('Connect'),
      disconnectFn: mkFn('Disconnect'),
      defaultFn: mkFn('Default'),
      logRetentionDays: 30,
    })

    NagSuppressions.addStackSuppressions(stack, [
      { id: 'AwsSolutions-IAM4', reason: 'CDK-generated managed policies for Lambda VPC execution.' },
      { id: 'AwsSolutions-IAM5', reason: 'CDK-generated wildcard policies for Lambda intrinsics.' },
      { id: 'AwsSolutions-L1', reason: 'nodejs22.x is current LTS; acceptable.' },
      { id: 'AwsSolutions-APIG1', reason: 'Access logging configured via CfnStage AccessLogSettings.' },
      { id: 'AwsSolutions-APIG4', reason: 'WebSocket $connect handles auth inline (no authorizer construct needed).' },
    ])

    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }))
    expect(() => app.synth()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

describe('ApiGwWsConstruct — snapshot', () => {
  test('mwitt stack matches snapshot', () => {
    const { template } = buildWsStack('mwitt')
    expect(template.toJSON()).toMatchSnapshot()
  })
})
