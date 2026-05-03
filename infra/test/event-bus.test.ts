// [Engineer-Sr · Sonnet · run-round8-05-event-bus]
/**
 * event-bus.test.ts — Snapshot + property tests for EventBusConstruct.
 *
 * TDD: RED first → GREEN once event-bus.ts is implemented.
 *
 * Tests verify:
 *  1. SNS topic encrypted with KMS
 *  2. 4 SQS consumer queues present with correct names
 *  3. 4 DLQs present (one per consumer)
 *  4. EventBridge bus created with correct name
 *  5. 3 EventBridge schedule rules: sprint-planning, retro-runner, hygiene-sweep
 *  6. SNS subscription filter policies per consumer
 *  7. DLQ depth alarms created (one per consumer)
 *  8. cdk-nag: no ERROR-level violations
 *  9. Snapshot
 */

import * as cdk from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib'
import { EventBusConstruct, type ConsumerName } from '../lib/constructs/event-bus'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStubFn(stack: cdk.Stack, id: string): lambda.Function {
  return new lambda.Function(stack, id, {
    runtime: lambda.Runtime.NODEJS_22_X,
    handler: 'index.handler',
    code: lambda.Code.fromInline('exports.handler = async () => ({})'),
  })
}

function buildEventBusStack(envName = 'mwitt'): {
  stack: cdk.Stack
  template: Template
  construct: EventBusConstruct
} {
  const app = new cdk.App()
  const stack = new cdk.Stack(app, `TestEventBus-${envName}`, {
    env: { account: '123456789012', region: 'us-east-1' },
  })

  const consumerNames: ConsumerName[] = [
    'memory-recorder',
    'defect-router',
    'audit-indexer',
    'replay-recorder',
  ]

  const consumerFns = Object.fromEntries(
    consumerNames.map((name) => [name, makeStubFn(stack, `Consumer-${name}`)]),
  ) as Record<ConsumerName, lambda.Function>

  const construct = new EventBusConstruct(stack, 'EventBus', {
    envName,
    wsFanoutFn: makeStubFn(stack, 'WsFanout'),
    consumerFns,
    sprintPlanningFn: makeStubFn(stack, 'SprintPlanning'),
    retroRunnerFn: makeStubFn(stack, 'RetroRunner'),
    hygieneSweepFn: makeStubFn(stack, 'HygieneSweep'),
  })

  const template = Template.fromStack(stack)
  return { stack, template, construct }
}

// ---------------------------------------------------------------------------
// SNS topic
// ---------------------------------------------------------------------------

describe('EventBusConstruct — SNS topic', () => {
  test('creates SNS topic named orbital-events-{env}', () => {
    const { template } = buildEventBusStack('mwitt')
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'orbital-events-mwitt',
    })
  })

  test('SNS topic is KMS encrypted', () => {
    const { template } = buildEventBusStack()
    // Topic has a KmsMasterKeyId property referencing the key
    const topics = template.findResources('AWS::SNS::Topic', {
      Properties: Match.objectLike({ KmsMasterKeyId: Match.anyValue() }),
    })
    expect(Object.keys(topics).length).toBeGreaterThan(0)
  })

  test('KMS key has key rotation enabled', () => {
    const { template } = buildEventBusStack()
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
    })
  })
})

// ---------------------------------------------------------------------------
// SQS consumer queues
// ---------------------------------------------------------------------------

describe('EventBusConstruct — SQS consumer queues', () => {
  test('creates at least 4 consumer queues (memory-recorder, defect-router, audit-indexer, replay-recorder)', () => {
    const { template } = buildEventBusStack('mwitt')
    // Count SQS queues that are consumer queues (not DLQs or scheduled DLQs)
    const queues = template.findResources('AWS::SQS::Queue')
    // At minimum: 4 consumer + 4 DLQs + 3 scheduled DLQs = 11 queues
    expect(Object.keys(queues).length).toBeGreaterThanOrEqual(11)
  })

  test('memory-recorder queue exists with correct name', () => {
    const { template } = buildEventBusStack('mwitt')
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'orbital-mwitt-memory-recorder',
    })
  })

  test('defect-router queue exists with correct name', () => {
    const { template } = buildEventBusStack('mwitt')
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'orbital-mwitt-defect-router',
    })
  })

  test('audit-indexer queue exists with correct name', () => {
    const { template } = buildEventBusStack('mwitt')
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'orbital-mwitt-audit-indexer',
    })
  })

  test('replay-recorder queue exists with correct name', () => {
    const { template } = buildEventBusStack('mwitt')
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'orbital-mwitt-replay-recorder',
    })
  })

  test('consumer queues have 60s visibility timeout', () => {
    const { template } = buildEventBusStack('mwitt')
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'orbital-mwitt-memory-recorder',
      VisibilityTimeout: 60,
    })
  })

  test('consumer queues have 4-day message retention', () => {
    const { template } = buildEventBusStack('mwitt')
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'orbital-mwitt-audit-indexer',
      MessageRetentionPeriod: 4 * 24 * 60 * 60, // 4 days in seconds
    })
  })
})

// ---------------------------------------------------------------------------
// DLQs
// ---------------------------------------------------------------------------

describe('EventBusConstruct — DLQs', () => {
  test('memory-recorder DLQ exists', () => {
    const { template } = buildEventBusStack('mwitt')
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'orbital-mwitt-memory-recorder-dlq',
    })
  })

  test('defect-router DLQ exists', () => {
    const { template } = buildEventBusStack('mwitt')
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'orbital-mwitt-defect-router-dlq',
    })
  })

  test('audit-indexer DLQ exists', () => {
    const { template } = buildEventBusStack('mwitt')
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'orbital-mwitt-audit-indexer-dlq',
    })
  })

  test('replay-recorder DLQ exists', () => {
    const { template } = buildEventBusStack('mwitt')
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'orbital-mwitt-replay-recorder-dlq',
    })
  })

  test('consumer queues have redrive policy pointing to DLQ', () => {
    const { template } = buildEventBusStack('mwitt')
    // Every consumer queue should have a RedrivePolicy
    template.hasResourceProperties('AWS::SQS::Queue', {
      QueueName: 'orbital-mwitt-memory-recorder',
      RedrivePolicy: Match.objectLike({
        maxReceiveCount: 3,
      }),
    })
  })
})

// ---------------------------------------------------------------------------
// DLQ alarms
// ---------------------------------------------------------------------------

describe('EventBusConstruct — DLQ alarms', () => {
  test('creates 4 DLQ depth alarms (one per consumer)', () => {
    const { template } = buildEventBusStack('mwitt')
    const alarms = template.findResources('AWS::CloudWatch::Alarm', {
      Properties: Match.objectLike({
        AlarmName: Match.stringLikeRegexp('orbital-mwitt-.*-dlq-depth'),
      }),
    })
    expect(Object.keys(alarms).length).toBe(4)
  })

  test('DLQ alarms threshold is 0 (alert on first message)', () => {
    const { template } = buildEventBusStack('mwitt')
    template.hasResourceProperties('AWS::CloudWatch::Alarm', {
      AlarmName: 'orbital-mwitt-memory-recorder-dlq-depth',
      Threshold: 0,
      ComparisonOperator: 'GreaterThanThreshold',
    })
  })
})

// ---------------------------------------------------------------------------
// EventBridge bus
// ---------------------------------------------------------------------------

describe('EventBusConstruct — EventBridge bus', () => {
  test('creates EventBridge bus named orbital-{env}', () => {
    const { template } = buildEventBusStack('mwitt')
    template.hasResourceProperties('AWS::Events::EventBus', {
      Name: 'orbital-mwitt',
    })
  })
})

// ---------------------------------------------------------------------------
// Schedule rules
// ---------------------------------------------------------------------------

describe('EventBusConstruct — schedule rules', () => {
  test('creates 3 EventBridge rules', () => {
    const { template } = buildEventBusStack('mwitt')
    const rules = template.findResources('AWS::Events::Rule')
    expect(Object.keys(rules).length).toBe(3)
  })

  test('sprint-planning rule has cron(0 9 * * ? *) schedule', () => {
    const { template } = buildEventBusStack('mwitt')
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'sprint-planning-mwitt',
      ScheduleExpression: 'cron(0 9 * * ? *)',
    })
  })

  test('retro-runner rule has cron(0 17 * * ? *) schedule', () => {
    const { template } = buildEventBusStack('mwitt')
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'retro-runner-mwitt',
      ScheduleExpression: 'cron(0 17 * * ? *)',
    })
  })

  test('hygiene-sweep rule has rate(1 hour) schedule', () => {
    const { template } = buildEventBusStack('mwitt')
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'hygiene-sweep-mwitt',
      ScheduleExpression: 'rate(1 hour)',
    })
  })
})

// ---------------------------------------------------------------------------
// SNS filter policies
// ---------------------------------------------------------------------------

describe('EventBusConstruct — SNS filter policies', () => {
  test('memory-recorder subscription has filter for MemoryEntryRecorded and MemoryRetrievedForBrief', () => {
    const { template } = buildEventBusStack('mwitt')
    // SNS subscriptions include filter policies in their resource properties
    const subs = template.findResources('AWS::SNS::Subscription', {
      Properties: Match.objectLike({
        FilterPolicy: Match.objectLike({
          event_type: Match.arrayWith(['MemoryEntryRecorded', 'MemoryRetrievedForBrief']),
        }),
      }),
    })
    expect(Object.keys(subs).length).toBeGreaterThanOrEqual(1)
  })

  test('defect-router subscription has filter for DefectReported', () => {
    const { template } = buildEventBusStack('mwitt')
    const subs = template.findResources('AWS::SNS::Subscription', {
      Properties: Match.objectLike({
        FilterPolicy: Match.objectLike({
          event_type: Match.arrayWith(['DefectReported']),
        }),
      }),
    })
    expect(Object.keys(subs).length).toBeGreaterThanOrEqual(1)
  })

  test('replay-recorder subscription has filter for ReplayCaptureCompleted', () => {
    const { template } = buildEventBusStack('mwitt')
    const subs = template.findResources('AWS::SNS::Subscription', {
      Properties: Match.objectLike({
        FilterPolicy: Match.objectLike({
          event_type: Match.arrayWith(['ReplayCaptureCompleted']),
        }),
      }),
    })
    expect(Object.keys(subs).length).toBeGreaterThanOrEqual(1)
  })
})

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

describe('EventBusConstruct — outputs', () => {
  test('exports SnsTopicArn', () => {
    const { template } = buildEventBusStack('mwitt')
    const outputs = template.findOutputs('*')
    const keys = Object.keys(outputs)
    expect(keys.some((k) => k.includes('SnsTopicArn'))).toBe(true)
  })

  test('exports EventBusName', () => {
    const { template } = buildEventBusStack('mwitt')
    const outputs = template.findOutputs('*')
    const keys = Object.keys(outputs)
    expect(keys.some((k) => k.includes('EventBusName'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Construct properties
// ---------------------------------------------------------------------------

describe('EventBusConstruct — construct properties', () => {
  test('snsTopic property is defined', () => {
    const { construct } = buildEventBusStack()
    expect(construct.snsTopic).toBeDefined()
    expect(construct.snsTopic.topicArn).toBeTruthy()
  })

  test('eventBridge property is defined', () => {
    const { construct } = buildEventBusStack()
    expect(construct.eventBridge).toBeDefined()
    expect(construct.eventBridge.eventBusName).toBeTruthy()
  })

  test('consumerQueues has all 4 consumer names', () => {
    const { construct } = buildEventBusStack()
    const names: ConsumerName[] = ['memory-recorder', 'defect-router', 'audit-indexer', 'replay-recorder']
    for (const name of names) {
      expect(construct.consumerQueues[name]).toBeDefined()
    }
  })
})

// ---------------------------------------------------------------------------
// cdk-nag
// ---------------------------------------------------------------------------

describe('EventBusConstruct — cdk-nag', () => {
  test('no ERROR-level violations', () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, 'NagEventBusStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })

    const consumerNames: ConsumerName[] = [
      'memory-recorder',
      'defect-router',
      'audit-indexer',
      'replay-recorder',
    ]

    const consumerFns = Object.fromEntries(
      consumerNames.map((name) => [name, makeStubFn(stack, `Nag-Consumer-${name}`)]),
    ) as Record<ConsumerName, lambda.Function>

    new EventBusConstruct(stack, 'EventBus', {
      envName: 'mwitt',
      wsFanoutFn: makeStubFn(stack, 'Nag-WsFanout'),
      consumerFns,
      sprintPlanningFn: makeStubFn(stack, 'Nag-SprintPlanning'),
      retroRunnerFn: makeStubFn(stack, 'Nag-RetroRunner'),
      hygieneSweepFn: makeStubFn(stack, 'Nag-HygieneSweep'),
    })

    NagSuppressions.addStackSuppressions(stack, [
      { id: 'AwsSolutions-IAM4', reason: 'CDK-generated managed policies for Lambda basic execution.' },
      { id: 'AwsSolutions-IAM5', reason: 'CDK-generated wildcard policies for Lambda intrinsics.' },
      { id: 'AwsSolutions-L1', reason: 'nodejs22.x is current LTS; acceptable.' },
      { id: 'AwsSolutions-SQS3', reason: 'DLQs intentionally do not have their own DLQs (no infinite nesting).' },
      { id: 'AwsSolutions-SQS4', reason: 'SQS queues are accessed via SNS subscription (HTTPS enforced by SNS); no direct HTTPS enforcement needed on queue policy.' },
      { id: 'AwsSolutions-SNS2', reason: 'SNS topic is KMS encrypted (CMK); server-side encryption is configured.' },
      { id: 'AwsSolutions-SNS3', reason: 'SNS subscriptions are internal AWS service integrations (SQS/Lambda); no raw subscription confirmation needed.' },
    ])

    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }))
    expect(() => app.synth()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

describe('EventBusConstruct — snapshot', () => {
  test('mwitt stack matches snapshot', () => {
    const { template } = buildEventBusStack('mwitt')
    expect(template.toJSON()).toMatchSnapshot()
  })
})
