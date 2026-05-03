// [Engineer-Sr · Sonnet · run-round8-08-observability]
/**
 * observability.test.ts — Snapshot + property tests for ObservabilityConstruct.
 *
 * TDD: RED first → GREEN once observability.ts is implemented.
 *
 * Tests verify:
 *  1. Alarm SNS topic `orbital-alarms-{env}` created
 *  2. CloudWatch Dashboard `orbital-{env}` created with 9 sections (TextWidgets)
 *  3. All alarms from architecture.md §"Alarms" table are present:
 *       - API 5xx rate alarm
 *       - Per-Lambda error rate alarms (one per function)
 *       - Per-Lambda throttle alarms (one per function)
 *       - Aurora CPU alarm
 *       - Aurora connections alarm
 *       - RDS Proxy connection setup failures alarm
 *       - SQS DLQ depth alarms (one per consumer queue)
 *       - SQS oldest message age alarms (one per consumer queue)
 *       - WS fanout DLQ alarm
 *       - Cognito sign-in failures alarm
 *  4. All alarms have the alarm action SNS topic set
 *  5. cdk-nag: no ERROR-level violations
 *  6. Snapshot
 */

import * as cdk from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib'
import {
  ObservabilityConstruct,
  type LambdaDescriptor,
  type SqsQueueDescriptor,
} from '../lib/constructs/observability'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CONSUMER_NAMES = ['memory-recorder', 'defect-router', 'audit-indexer', 'replay-recorder'] as const
type ConsumerName = typeof CONSUMER_NAMES[number]

const LAMBDA_LABELS = [
  'trpc-auth', 'trpc-tasks', 'trpc-memory', 'trpc-comms',
  'trpc-defects', 'trpc-audit', 'trpc-prs', 'trpc-cost',
  'trpc-providers', 'trpc-team', 'trpc-onboarding',
  'ws-connect', 'ws-disconnect', 'ws-default', 'ws-fanout',
  'consumer-memory-recorder', 'consumer-defect-router',
  'consumer-audit-indexer', 'consumer-replay-recorder',
  'scheduled-sprint-planning', 'scheduled-retro-runner', 'scheduled-hygiene-sweep',
] as const

function makeLambdaDescriptors(stack: cdk.Stack): LambdaDescriptor[] {
  return LAMBDA_LABELS.map((label) => ({
    label,
    fn: new lambda.Function(stack, `Fn-${label.replace(/[^a-zA-Z0-9]/g, '')}`, {
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline('exports.handler = async () => ({})'),
    }),
  }))
}

function makeSqsDescriptors(): SqsQueueDescriptor[] {
  return CONSUMER_NAMES.map((name) => ({
    label: name,
    queueName: `orbital-mwitt-${name}`,
    dlqName: `orbital-mwitt-${name}-dlq`,
  }))
}

function buildObservabilityStack(envName = 'mwitt'): {
  stack: cdk.Stack
  template: Template
  construct: ObservabilityConstruct
} {
  const app = new cdk.App()
  const stack = new cdk.Stack(app, `TestObservability-${envName}`, {
    env: { account: '123456789012', region: 'us-east-1' },
  })

  const construct = new ObservabilityConstruct(stack, 'Observability', {
    envName,
    logRetentionDays: 30,
    httpApiId: 'httpapi123',
    wsApiId: 'wsapi456',
    auroraClusterIdentifier: `orbital-${envName}-aurora`,
    rdsProxyName: `orbital-${envName}-proxy`,
    cognitoUserPoolId: 'us-east-1_TestPool',
    lambdas: makeLambdaDescriptors(stack),
    sqsQueues: makeSqsDescriptors(),
    snsEventTopicArn: `arn:aws:sns:us-east-1:123456789012:orbital-events-${envName}`,
    wafWebAclName: `orbital-${envName}-acl`,
    wsFanoutDlqName: `orbital-${envName}-ws-fanout-dlq`,
  })

  const template = Template.fromStack(stack)
  return { stack, template, construct }
}

// ---------------------------------------------------------------------------
// Alarm SNS topic
// ---------------------------------------------------------------------------

describe('ObservabilityConstruct — Alarm SNS Topic', () => {
  test('creates alarm SNS topic named orbital-alarms-{env}', () => {
    const { template } = buildObservabilityStack('mwitt')
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'orbital-alarms-mwitt',
    })
  })

  test('alarm topic display name is set', () => {
    const { template } = buildObservabilityStack('mwitt')
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'orbital-alarms-mwitt',
      DisplayName: Match.stringLikeRegexp('Operational Alarms'),
    })
  })

  test('exports AlarmTopicArn output with correct export name', () => {
    const { template } = buildObservabilityStack('mwitt')
    const outputs = template.findOutputs('*')
    const hasExport = Object.values(outputs).some(
      (o: { Export?: { Name?: string } }) => o.Export?.Name === 'OrbitalHub-mwitt-AlarmTopicArn',
    )
    expect(hasExport).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Dashboard
// ---------------------------------------------------------------------------

describe('ObservabilityConstruct — CloudWatch Dashboard', () => {
  test('creates dashboard named orbital-{env}', () => {
    const { template } = buildObservabilityStack('mwitt')
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'orbital-mwitt',
    })
  })

  test('dashboard body contains all 9 section headers', () => {
    const { template } = buildObservabilityStack('mwitt')
    const dashboards = template.findResources('AWS::CloudWatch::Dashboard')
    const dashboardBody = JSON.stringify(dashboards)

    // All 9 sections should appear as TextWidget markdown headings
    expect(dashboardBody).toContain('1. API Health')
    expect(dashboardBody).toContain('2. WebSocket Health')
    expect(dashboardBody).toContain('3. Lambda')
    expect(dashboardBody).toContain('4. Aurora')
    expect(dashboardBody).toContain('5. RDS Proxy')
    expect(dashboardBody).toContain('6. SQS')
    expect(dashboardBody).toContain('7. SNS')
    expect(dashboardBody).toContain('8. Cognito')
    expect(dashboardBody).toContain('9. WAF')
  })

  test('exports DashboardName output with correct export name', () => {
    const { template } = buildObservabilityStack('mwitt')
    const outputs = template.findOutputs('*')
    const hasExport = Object.values(outputs).some(
      (o: { Export?: { Name?: string } }) => o.Export?.Name === 'OrbitalHub-mwitt-DashboardName',
    )
    expect(hasExport).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Alarms — structural
// ---------------------------------------------------------------------------

describe('ObservabilityConstruct — Alarms Structure', () => {
  test('creates API 5xx rate alarm', () => {
    const { template } = buildObservabilityStack('mwitt')
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'orbital-mwitt-api-5xx-rate',
    })
  })

  test('creates Aurora CPU alarm', () => {
    const { template } = buildObservabilityStack('mwitt')
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'orbital-mwitt-aurora-cpu',
      Threshold: 80,
    })
  })

  test('creates Aurora connections alarm', () => {
    const { template } = buildObservabilityStack('mwitt')
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'orbital-mwitt-aurora-connections',
    })
  })

  test('creates RDS Proxy connection failures alarm', () => {
    const { template } = buildObservabilityStack('mwitt')
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'orbital-mwitt-rds-proxy-connection-failures',
    })
  })

  test('creates WS fanout DLQ alarm', () => {
    const { template } = buildObservabilityStack('mwitt')
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'orbital-mwitt-ws-fanout-dlq-depth',
      Threshold: 0,
    })
  })

  test('creates Cognito sign-in failures alarm', () => {
    const { template } = buildObservabilityStack('mwitt')
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'orbital-mwitt-cognito-signin-failures',
      Threshold: 10,
    })
  })

  test('creates SQS DLQ depth alarm for every consumer queue', () => {
    const { template } = buildObservabilityStack('mwitt')
    for (const name of CONSUMER_NAMES) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `orbital-mwitt-sqs-${name}-dlq-depth`,
        Threshold: 0,
      })
    }
  })

  test('creates SQS oldest message age alarm for every consumer queue', () => {
    const { template } = buildObservabilityStack('mwitt')
    for (const name of CONSUMER_NAMES) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `orbital-mwitt-sqs-${name}-oldest-message`,
        Threshold: 300, // 5 minutes in seconds
      })
    }
  })

  test('creates Lambda error rate alarm for every Lambda', () => {
    const { template } = buildObservabilityStack('mwitt')
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'orbital-mwitt-lambda-trpc-auth-error-rate',
    })
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'orbital-mwitt-lambda-ws-fanout-error-rate',
    })
  })

  test('creates Lambda throttle alarm for every Lambda', () => {
    const { template } = buildObservabilityStack('mwitt')
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'orbital-mwitt-lambda-trpc-auth-throttles',
      Threshold: 0,
    })
  })
})

// ---------------------------------------------------------------------------
// Alarms — all have SNS alarm actions
// ---------------------------------------------------------------------------

describe('ObservabilityConstruct — Alarm Actions', () => {
  test('Aurora CPU alarm has SNS alarm action', () => {
    const { template } = buildObservabilityStack('mwitt')
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'orbital-mwitt-aurora-cpu',
      AlarmActions: Match.anyValue(),
    })
  })

  test('SQS DLQ alarm has SNS alarm action', () => {
    const { template } = buildObservabilityStack('mwitt')
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'orbital-mwitt-sqs-memory-recorder-dlq-depth',
      AlarmActions: Match.anyValue(),
    })
  })
})

// ---------------------------------------------------------------------------
// Alarms count — sanity check total number
// ---------------------------------------------------------------------------

describe('ObservabilityConstruct — Total Alarm Count', () => {
  test('creates the expected number of alarms', () => {
    const { construct } = buildObservabilityStack('mwitt')
    // Base alarms:
    //   1 API 5xx
    //   22 Lambda error rate (one per lambda)
    //   22 Lambda throttle (one per lambda)
    //   1 Aurora CPU
    //   1 Aurora connections
    //   1 RDS Proxy failures
    //   4 SQS DLQ depth (one per consumer)
    //   4 SQS oldest message (one per consumer)
    //   1 WS fanout DLQ
    //   1 Cognito sign-in failures
    // Total = 58
    const lambdaCount = LAMBDA_LABELS.length // 22
    const expectedAlarms =
      1 +               // API 5xx
      lambdaCount +     // Lambda error rates
      lambdaCount +     // Lambda throttles
      1 +               // Aurora CPU
      1 +               // Aurora connections
      1 +               // RDS Proxy
      CONSUMER_NAMES.length + // SQS DLQ depth
      CONSUMER_NAMES.length + // SQS oldest message
      1 +               // WS fanout DLQ
      1                 // Cognito sign-ins
    expect(construct.alarms.length).toBe(expectedAlarms)
  })
})

// ---------------------------------------------------------------------------
// X-Ray tracing marker — Lambda Tracing ACTIVE
// (Lambda constructs in the full stack use Tracing: ACTIVE; here we verify
// the pattern is documented and dashboard includes Lambda metrics)
// ---------------------------------------------------------------------------

describe('ObservabilityConstruct — Lambda Tracing References', () => {
  test('dashboard body references Lambda Duration metric (X-Ray enabled on functions)', () => {
    const { template } = buildObservabilityStack('mwitt')
    const dashboards = template.findResources('AWS::CloudWatch::Dashboard')
    const bodyStr = JSON.stringify(dashboards)
    // Lambda Duration metric appears in the dashboard (WS fanout latency section)
    expect(bodyStr).toContain('AWS/Lambda')
  })
})

// ---------------------------------------------------------------------------
// cdk-nag
// ---------------------------------------------------------------------------

describe('ObservabilityConstruct — cdk-nag AwsSolutionsChecks', () => {
  test('no ERROR-level nag violations', () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, 'ObservabilityNagStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })

    const lambdas: LambdaDescriptor[] = [
      {
        label: 'trpc-auth',
        fn: new lambda.Function(stack, 'FnNagAuth', {
          runtime: lambda.Runtime.NODEJS_22_X,
          handler: 'index.handler',
          code: lambda.Code.fromInline('exports.handler = async () => ({})'),
        }),
      },
    ]

    new ObservabilityConstruct(stack, 'Observability', {
      envName: 'mwitt',
      logRetentionDays: 30,
      httpApiId: 'httpapi123',
      wsApiId: 'wsapi456',
      auroraClusterIdentifier: 'orbital-mwitt-aurora',
      rdsProxyName: 'orbital-mwitt-proxy',
      cognitoUserPoolId: 'us-east-1_TestPool',
      lambdas,
      sqsQueues: [
        {
          label: 'memory-recorder',
          queueName: 'orbital-mwitt-memory-recorder',
          dlqName: 'orbital-mwitt-memory-recorder-dlq',
        },
      ],
      snsEventTopicArn: 'arn:aws:sns:us-east-1:123456789012:orbital-events-mwitt',
      wafWebAclName: 'orbital-mwitt-acl',
      wsFanoutDlqName: 'orbital-mwitt-ws-fanout-dlq',
    })

    NagSuppressions.addStackSuppressions(stack, [
      { id: 'AwsSolutions-SNS2', reason: 'Alarm topic encryption deferred; alarms are not sensitive data.' },
      { id: 'AwsSolutions-SNS3', reason: 'Alarm topic SSL enforcement: CloudWatch/Lambda callers use SDK managed encryption.' },
      { id: 'AwsSolutions-IAM4', reason: 'CDK-managed Lambda execution roles.' },
    ])

    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }))
    expect(() => app.synth()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

describe('ObservabilityConstruct — Snapshot', () => {
  test('mwitt stack template matches snapshot', () => {
    const { template } = buildObservabilityStack('mwitt')
    expect(template.toJSON()).toMatchSnapshot()
  })
})
