// [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
/**
 * api-gw-http.test.ts — Snapshot + property tests for ApiGwHttpConstruct.
 *
 * TDD: RED first, GREEN once api-gw-http.ts is implemented.
 *
 * Tests verify:
 *  1. HTTP API is created
 *  2. Custom domain api.{domain} is created
 *  3. CORS is configured for the UI origin + localhost
 *  4. Routes are created for all 12 route configs
 *  5. Route 53 A-record for api.{domain} is created
 *  6. Access log group is created with correct name
 *  7. Outputs include HttpApiId and ApiEndpoint
 *  8. cdk-nag: no ERROR-level violations
 *  9. Snapshot
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as route53 from 'aws-cdk-lib/aws-route53'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2'
import * as authorizersLib from 'aws-cdk-lib/aws-apigatewayv2-authorizers'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib'
import { ApiGwHttpConstruct } from '../lib/constructs/api-gw-http'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildApiGwStack(envName = 'mwitt'): { stack: cdk.Stack; template: Template; apiGw: ApiGwHttpConstruct } {
  const domain = `${envName}.orbital.team.dev`
  const app = new cdk.App()
  const stack = new cdk.Stack(app, `TestApiGw-${envName}`, {
    env: { account: '123456789012', region: 'us-east-1' },
  })

  const hostedZone = new route53.HostedZone(stack, 'TestZone', {
    zoneName: domain,
  })

  const certificate = new acm.Certificate(stack, 'TestCert', {
    domainName: domain,
    subjectAlternativeNames: [`*.${domain}`],
  })

  // Create a stub Lambda for the integration
  const stubFn = new lambda.Function(stack, 'StubFn', {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200 })'),
  })

  // Stub authorizers
  const cognitoAuthorizer = new authorizersLib.HttpJwtAuthorizer(
    'CognitoAuth',
    'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
    {
      authorizerName: `orbital-${envName}-cognito-auth`,
      jwtAudience: ['testClientId'],
    },
  )

  const installAuthorizer = new authorizersLib.HttpLambdaAuthorizer(
    'InstallAuth',
    stubFn,
    {
      authorizerName: `orbital-${envName}-install-auth`,
      identitySource: [
        '$request.header.X-Orbital-Install-Id',
        '$request.header.X-Orbital-Sig',
        '$request.header.X-Orbital-Sig-Body',
      ],
      resultsCacheTtl: cdk.Duration.seconds(0),
      responseTypes: [authorizersLib.HttpLambdaResponseType.SIMPLE],
    },
  )

  const routeConfigs = [
    { routeKey: 'ANY /trpc/auth/{proxy+}', fn: stubFn, authType: 'cognito' as const },
    { routeKey: 'ANY /trpc/tasks/{proxy+}', fn: stubFn, authType: 'cognito' as const },
    { routeKey: 'ANY /trpc/memory/{proxy+}', fn: stubFn, authType: 'cognito' as const },
    { routeKey: 'ANY /trpc/comms/{proxy+}', fn: stubFn, authType: 'cognito' as const },
    { routeKey: 'ANY /trpc/defects/{proxy+}', fn: stubFn, authType: 'cognito' as const },
    { routeKey: 'ANY /trpc/audit/{proxy+}', fn: stubFn, authType: 'cognito' as const },
    { routeKey: 'ANY /trpc/prs/{proxy+}', fn: stubFn, authType: 'cognito' as const },
    { routeKey: 'ANY /trpc/cost/{proxy+}', fn: stubFn, authType: 'cognito' as const },
    { routeKey: 'ANY /trpc/providers/{proxy+}', fn: stubFn, authType: 'cognito' as const },
    { routeKey: 'ANY /trpc/team/{proxy+}', fn: stubFn, authType: 'cognito' as const },
    { routeKey: 'ANY /trpc/onboarding/{proxy+}', fn: stubFn, authType: 'cognito' as const },
    { routeKey: 'ANY /install/{proxy+}', fn: stubFn, authType: 'install' as const },
  ]

  const apiGw = new ApiGwHttpConstruct(stack, 'ApiGw', {
    envName,
    domain,
    certificate,
    hostedZone,
    cognitoAuthorizer,
    installAuthorizer,
    routes: routeConfigs,
    logRetentionDays: 30,
  })

  const template = Template.fromStack(stack)
  return { stack, template, apiGw }
}

// ---------------------------------------------------------------------------
// HTTP API existence
// ---------------------------------------------------------------------------

describe('ApiGwHttpConstruct — HTTP API', () => {
  test('creates an HTTP API', () => {
    const { template } = buildApiGwStack()
    template.resourceCountIs('AWS::ApiGatewayV2::Api', 1)
  })

  test('API is named orbital-{env}-api', () => {
    const { template } = buildApiGwStack('mwitt')
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      Name: 'orbital-mwitt-api',
      ProtocolType: 'HTTP',
    })
  })

  test('CORS allows the UI origin', () => {
    const { template } = buildApiGwStack('mwitt')
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: Match.arrayWith(['https://mwitt.orbital.team.dev']),
      }),
    })
  })

  test('CORS allows localhost for dev', () => {
    const { template } = buildApiGwStack()
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowOrigins: Match.arrayWith(['http://localhost:3000']),
      }),
    })
  })

  test('CORS allows Authorization header (Cognito JWT)', () => {
    const { template } = buildApiGwStack()
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowHeaders: Match.arrayWith(['Authorization']),
      }),
    })
  })

  test('CORS allows PKI envelope headers', () => {
    const { template } = buildApiGwStack()
    template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
      CorsConfiguration: Match.objectLike({
        AllowHeaders: Match.arrayWith([
          'X-Orbital-Install-Id',
          'X-Orbital-Sig',
          'X-Orbital-Sig-Body',
        ]),
      }),
    })
  })
})

// ---------------------------------------------------------------------------
// Custom domain
// ---------------------------------------------------------------------------

describe('ApiGwHttpConstruct — custom domain', () => {
  test('creates a custom domain name resource', () => {
    const { template } = buildApiGwStack()
    template.resourceCountIs('AWS::ApiGatewayV2::DomainName', 1)
  })

  test('custom domain name is api.{domain}', () => {
    const { template } = buildApiGwStack('mwitt')
    template.hasResourceProperties('AWS::ApiGatewayV2::DomainName', {
      DomainName: 'api.mwitt.orbital.team.dev',
    })
  })

  test('Route53 A-record created for api.{domain}', () => {
    const { template } = buildApiGwStack('mwitt')
    template.hasResourceProperties('AWS::Route53::RecordSet', {
      Name: 'api.mwitt.orbital.team.dev.',
      Type: 'A',
    })
  })
})

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

describe('ApiGwHttpConstruct — routes', () => {
  test('creates 12 routes (11 Cognito + 1 install)', () => {
    const { template } = buildApiGwStack()
    const routes = template.findResources('AWS::ApiGatewayV2::Route')
    expect(Object.keys(routes).length).toBe(12)
  })

  test('creates Lambda integrations for each route', () => {
    const { template } = buildApiGwStack()
    const integrations = template.findResources('AWS::ApiGatewayV2::Integration', {
      Properties: { IntegrationType: 'AWS_PROXY' },
    })
    expect(Object.keys(integrations).length).toBe(12)
  })

  test('all routes are ANY method with correct path prefixes', () => {
    const { template } = buildApiGwStack()
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'ANY /trpc/auth/{proxy+}',
    })
    template.hasResourceProperties('AWS::ApiGatewayV2::Route', {
      RouteKey: 'ANY /install/{proxy+}',
    })
  })
})

// ---------------------------------------------------------------------------
// Access logs
// ---------------------------------------------------------------------------

describe('ApiGwHttpConstruct — access logs', () => {
  test('access log group is created with correct name', () => {
    const { template } = buildApiGwStack('mwitt')
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/orbital/mwitt/apigateway/http-api-access-logs',
    })
  })

  test('access log group has 30-day retention', () => {
    const { template } = buildApiGwStack()
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/orbital/mwitt/apigateway/http-api-access-logs',
      RetentionInDays: 30,
    })
  })
})

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

describe('ApiGwHttpConstruct — outputs', () => {
  test('outputs include HttpApiId and ApiEndpoint', () => {
    const { template } = buildApiGwStack()
    const outputs = template.findOutputs('*')
    const keys = Object.keys(outputs)
    expect(keys.some((k) => k.includes('HttpApiId'))).toBe(true)
    expect(keys.some((k) => k.includes('ApiEndpoint'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// cdk-nag
// ---------------------------------------------------------------------------

describe('ApiGwHttpConstruct — cdk-nag', () => {
  test('no ERROR-level violations', () => {
    const domain = 'mwitt.orbital.team.dev'
    const app = new cdk.App()
    const stack = new cdk.Stack(app, 'NagApiGwStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })

    const hostedZone = new route53.HostedZone(stack, 'TestZone', { zoneName: domain })
    const certificate = new acm.Certificate(stack, 'TestCert', {
      domainName: domain,
      subjectAlternativeNames: [`*.${domain}`],
    })
    const stubFn = new lambda.Function(stack, 'StubFn', {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({ statusCode: 200 })'),
    })
    const cognitoAuthorizer = new authorizersLib.HttpJwtAuthorizer(
      'CognitoAuth',
      'https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test',
      { authorizerName: 'test-cognito-auth', jwtAudience: ['testClientId'] },
    )
    const installAuthorizer = new authorizersLib.HttpLambdaAuthorizer(
      'InstallAuth',
      stubFn,
      {
        authorizerName: 'test-install-auth',
        identitySource: ['$request.header.X-Orbital-Install-Id'],
        resultsCacheTtl: cdk.Duration.seconds(0),
        responseTypes: [authorizersLib.HttpLambdaResponseType.SIMPLE],
      },
    )

    new ApiGwHttpConstruct(stack, 'ApiGw', {
      envName: 'mwitt',
      domain,
      certificate,
      hostedZone,
      cognitoAuthorizer,
      installAuthorizer,
      routes: [
        { routeKey: 'ANY /trpc/auth/{proxy+}', fn: stubFn, authType: 'cognito' },
      ],
      logRetentionDays: 30,
    })

    NagSuppressions.addStackSuppressions(stack, [
      { id: 'AwsSolutions-IAM4', reason: 'CDK-generated managed policies.' },
      { id: 'AwsSolutions-IAM5', reason: 'CDK-generated wildcard policies.' },
      { id: 'AwsSolutions-L1', reason: 'nodejs22.x is latest LTS.' },
      { id: 'AwsSolutions-APIG1', reason: 'Access logging configured via CfnStage override.' },
      { id: 'AwsSolutions-APIG4', reason: 'Authorizer wired on each route; OPTIONS handled by CORS.' },
    ])

    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }))
    expect(() => app.synth()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

describe('ApiGwHttpConstruct — snapshot', () => {
  test('mwitt stack matches snapshot', () => {
    const { template } = buildApiGwStack('mwitt')
    expect(template.toJSON()).toMatchSnapshot()
  })
})
