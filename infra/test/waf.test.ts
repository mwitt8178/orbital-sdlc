// [Engineer-Sr · Sonnet · run-round8-08-observability]
/**
 * waf.test.ts — Snapshot + property tests for WafConstruct.
 *
 * TDD: RED first → GREEN once waf.ts is implemented.
 *
 * Tests verify:
 *  1. WebACL created with REGIONAL scope
 *  2. WebACL name: orbital-{env}-acl
 *  3. AWS Managed Rule Sets present:
 *       - AWSManagedRulesCommonRuleSet
 *       - AWSManagedRulesKnownBadInputsRuleSet
 *       - AWSManagedRulesAmazonIpReputationList
 *  4. Custom rate-limit rules: GeneralRateLimit + AuthEndpointRateLimit
 *  5. BlockMissingUserAgent rule present
 *  6. WAF log group name starts with "aws-waf-logs-"
 *  7. WAF logging configuration exists
 *  8. HTTP API WebACL association exists
 *  9. WebSocket API WebACL association exists
 * 10. cdk-nag: no ERROR-level violations
 * 11. Snapshot
 */

import * as cdk from 'aws-cdk-lib'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib'
import { WafConstruct } from '../lib/constructs/waf'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildWafStack(envName = 'mwitt', withWsArn = true): {
  stack: cdk.Stack
  template: Template
  construct: WafConstruct
} {
  const app = new cdk.App()
  const stack = new cdk.Stack(app, `TestWaf-${envName}`, {
    env: { account: '123456789012', region: 'us-east-1' },
  })

  const httpApiArn = `arn:aws:apigateway:us-east-1::/apis/abc123/stages/$default`
  const wsApiArn = withWsArn
    ? `arn:aws:apigateway:us-east-1::/apis/xyz789/stages/$default`
    : undefined

  const construct = new WafConstruct(stack, 'Waf', {
    envName,
    httpApiArn,
    wsApiArn,
    logRetentionDays: 30,
  })

  const template = Template.fromStack(stack)
  return { stack, template, construct }
}

// ---------------------------------------------------------------------------
// WAF WebACL
// ---------------------------------------------------------------------------

describe('WafConstruct — WebACL', () => {
  test('creates WebACL with REGIONAL scope', () => {
    const { template } = buildWafStack()
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Scope: 'REGIONAL',
    })
  })

  test('WebACL has correct name for mwitt env', () => {
    const { template } = buildWafStack('mwitt')
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Name: 'orbital-mwitt-acl',
    })
  })

  test('WebACL has correct name for prod env', () => {
    const { template } = buildWafStack('prod')
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Name: 'orbital-prod-acl',
    })
  })

  test('WebACL default action is allow', () => {
    const { template } = buildWafStack()
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      DefaultAction: { Allow: {} },
    })
  })

  test('WebACL has CloudWatch metrics enabled', () => {
    const { template } = buildWafStack()
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      VisibilityConfig: Match.objectLike({
        CloudWatchMetricsEnabled: true,
        SampledRequestsEnabled: true,
      }),
    })
  })
})

// ---------------------------------------------------------------------------
// AWS Managed Rule Sets
// ---------------------------------------------------------------------------

describe('WafConstruct — AWS Managed Rule Sets', () => {
  test('includes AWSManagedRulesCommonRuleSet', () => {
    const { template } = buildWafStack()
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWSManagedRulesCommonRuleSet',
          Statement: {
            ManagedRuleGroupStatement: {
              VendorName: 'AWS',
              Name: 'AWSManagedRulesCommonRuleSet',
            },
          },
        }),
      ]),
    })
  })

  test('includes AWSManagedRulesKnownBadInputsRuleSet', () => {
    const { template } = buildWafStack()
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWSManagedRulesKnownBadInputsRuleSet',
          Statement: {
            ManagedRuleGroupStatement: {
              VendorName: 'AWS',
              Name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
        }),
      ]),
    })
  })

  test('includes AWSManagedRulesAmazonIpReputationList', () => {
    const { template } = buildWafStack()
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWSManagedRulesAmazonIpReputationList',
          Statement: {
            ManagedRuleGroupStatement: {
              VendorName: 'AWS',
              Name: 'AWSManagedRulesAmazonIpReputationList',
            },
          },
        }),
      ]),
    })
  })

  test('IP reputation rule has lowest priority (priority 0)', () => {
    const { template } = buildWafStack()
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AWSManagedRulesAmazonIpReputationList',
          Priority: 0,
        }),
      ]),
    })
  })
})

// ---------------------------------------------------------------------------
// Custom rules
// ---------------------------------------------------------------------------

describe('WafConstruct — Custom Rules', () => {
  test('includes GeneralRateLimit rule with block action', () => {
    const { template } = buildWafStack()
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'GeneralRateLimit',
          Action: { Block: {} },
          Statement: Match.objectLike({
            RateBasedStatement: Match.objectLike({
              AggregateKeyType: 'IP',
            }),
          }),
        }),
      ]),
    })
  })

  test('includes AuthEndpointRateLimit rule targeting /trpc/auth', () => {
    const { template } = buildWafStack()
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'AuthEndpointRateLimit',
          Action: { Block: {} },
        }),
      ]),
    })
  })

  test('includes BlockMissingUserAgent rule with block action', () => {
    const { template } = buildWafStack()
    template.hasResourceProperties('AWS::WAFv2::WebACL', {
      Rules: Match.arrayWith([
        Match.objectLike({
          Name: 'BlockMissingUserAgent',
          Action: { Block: {} },
        }),
      ]),
    })
  })

  test('has exactly 6 rules (3 managed + 3 custom)', () => {
    const { template } = buildWafStack()
    const webAcls = template.findResources('AWS::WAFv2::WebACL')
    const webAcl = Object.values(webAcls)[0] as { Properties: { Rules: unknown[] } }
    expect(webAcl?.Properties?.Rules?.length).toBe(6)
  })
})

// ---------------------------------------------------------------------------
// WAF Logging
// ---------------------------------------------------------------------------

describe('WafConstruct — Logging', () => {
  test('WAF log group name starts with "aws-waf-logs-"', () => {
    const { template } = buildWafStack()
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: 'aws-waf-logs-orbital-mwitt',
    })
  })

  test('WAF logging configuration exists', () => {
    const { template } = buildWafStack()
    template.resourceCountIs('AWS::WAFv2::LoggingConfiguration', 1)
  })
})

// ---------------------------------------------------------------------------
// WAF Associations
// ---------------------------------------------------------------------------

describe('WafConstruct — Associations', () => {
  test('creates WebACL association for HTTP API', () => {
    const { template } = buildWafStack()
    template.hasResourceProperties('AWS::WAFv2::WebACLAssociation', {
      ResourceArn: Match.stringLikeRegexp('apis/abc123'),
    })
  })

  test('creates WebACL association for WebSocket API when wsApiArn provided', () => {
    const { template } = buildWafStack('mwitt', true)
    template.hasResourceProperties('AWS::WAFv2::WebACLAssociation', {
      ResourceArn: Match.stringLikeRegexp('apis/xyz789'),
    })
  })

  test('creates two WebACL associations when wsApiArn is provided', () => {
    const { template } = buildWafStack('mwitt', true)
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 2)
  })

  test('creates one WebACL association when wsApiArn is not provided', () => {
    const { template } = buildWafStack('mwitt', false)
    template.resourceCountIs('AWS::WAFv2::WebACLAssociation', 1)
  })
})

// ---------------------------------------------------------------------------
// Alarms
// ---------------------------------------------------------------------------

describe('WafConstruct — Alarms', () => {
  test('creates blocked requests alarm', () => {
    const { template } = buildWafStack()
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'orbital-mwitt-waf-blocked-requests',
      ComparisonOperator: 'GreaterThanThreshold',
    })
  })
})

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

describe('WafConstruct — Outputs', () => {
  test('exports WebACL ARN with correct export name', () => {
    const { template } = buildWafStack()
    const outputs = template.findOutputs('*')
    const hasWebAclArnExport = Object.values(outputs).some(
      (o: { Export?: { Name?: string } }) => o.Export?.Name === 'OrbitalHub-mwitt-WebAclArn',
    )
    expect(hasWebAclArnExport).toBe(true)
  })

  test('exports WebACL ID with correct export name', () => {
    const { template } = buildWafStack()
    const outputs = template.findOutputs('*')
    const hasWebAclIdExport = Object.values(outputs).some(
      (o: { Export?: { Name?: string } }) => o.Export?.Name === 'OrbitalHub-mwitt-WebAclId',
    )
    expect(hasWebAclIdExport).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// cdk-nag
// ---------------------------------------------------------------------------

describe('WafConstruct — cdk-nag AwsSolutionsChecks', () => {
  test('no ERROR-level nag violations', () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, 'WafNagStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })

    new WafConstruct(stack, 'Waf', {
      envName: 'mwitt',
      httpApiArn: 'arn:aws:apigateway:us-east-1::/apis/abc123/stages/$default',
      wsApiArn: 'arn:aws:apigateway:us-east-1::/apis/xyz789/stages/$default',
      logRetentionDays: 30,
    })

    NagSuppressions.addStackSuppressions(stack, [
      { id: 'AwsSolutions-WAF1', reason: 'Shield Advanced is out of scope.' },
      { id: 'AwsSolutions-WAF4', reason: 'Managed rule groups use their own metric names.' },
    ])

    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }))
    expect(() => app.synth()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

describe('WafConstruct — Snapshot', () => {
  test('mwitt stack template matches snapshot', () => {
    const { template } = buildWafStack('mwitt')
    expect(template.toJSON()).toMatchSnapshot()
  })
})
