// [Engineer-Sr · Sonnet · run-round8-05-event-bus]
/**
 * event-bus-fanout-subscription.test.ts
 *
 * Verifies the ws-fanout Lambda is subscribed to the SNS topic with NO filter
 * policy (all events go to fanout for connection-based matching).
 *
 * Key assertions:
 *  1. A Lambda subscription exists in the SNS topic subscriptions.
 *  2. The Lambda subscription has no FilterPolicy (empty or absent).
 *  3. Exactly 5 subscriptions total: 4 SQS + 1 Lambda (ws-fanout).
 */

import * as cdk from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { Template, Match } from 'aws-cdk-lib/assertions'
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

function buildStack(): { stack: cdk.Stack; template: Template } {
  const app = new cdk.App()
  const stack = new cdk.Stack(app, 'TestFanoutSubscription', {
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

  new EventBusConstruct(stack, 'EventBus', {
    envName: 'mwitt',
    wsFanoutFn: makeStubFn(stack, 'WsFanout'),
    consumerFns,
    sprintPlanningFn: makeStubFn(stack, 'SprintPlanning'),
    retroRunnerFn: makeStubFn(stack, 'RetroRunner'),
    hygieneSweepFn: makeStubFn(stack, 'HygieneSweep'),
  })

  return { stack, template: Template.fromStack(stack) }
}

// ---------------------------------------------------------------------------
// ws-fanout Lambda subscription
// ---------------------------------------------------------------------------

describe('EventBusConstruct — ws-fanout Lambda subscription', () => {
  test('exactly 5 SNS subscriptions exist (4 SQS + 1 Lambda)', () => {
    const { template } = buildStack()
    const subs = template.findResources('AWS::SNS::Subscription')
    expect(Object.keys(subs).length).toBe(5)
  })

  test('a Lambda protocol subscription exists', () => {
    const { template } = buildStack()
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'lambda',
    })
  })

  test('Lambda subscription has NO filter policy (all events routed to fanout)', () => {
    const { template } = buildStack()
    // Find the Lambda-protocol subscription
    const subs = template.findResources('AWS::SNS::Subscription', {
      Properties: Match.objectLike({ Protocol: 'lambda' }),
    })
    expect(Object.keys(subs).length).toBe(1)

    const [sub] = Object.values(subs)
    // FilterPolicy should be absent or empty — the fanout receives ALL events.
    const props = (sub as { Properties: Record<string, unknown> }).Properties
    const filterPolicy = props['FilterPolicy']
    // Either no FilterPolicy property, or an empty object
    expect(
      filterPolicy === undefined || filterPolicy === null || Object.keys(filterPolicy as object).length === 0,
    ).toBe(true)
  })

  test('4 SQS subscriptions exist for consumer queues', () => {
    const { template } = buildStack()
    const sqsSubs = template.findResources('AWS::SNS::Subscription', {
      Properties: Match.objectLike({ Protocol: 'sqs' }),
    })
    expect(Object.keys(sqsSubs).length).toBe(4)
  })

  test('SQS subscriptions all have filter policies', () => {
    const { template } = buildStack()
    const sqsSubs = template.findResources('AWS::SNS::Subscription', {
      Properties: Match.objectLike({ Protocol: 'sqs' }),
    })
    for (const [_key, sub] of Object.entries(sqsSubs)) {
      const props = (sub as { Properties: Record<string, unknown> }).Properties
      // Each SQS subscription should have a non-empty FilterPolicy
      expect(props['FilterPolicy']).toBeDefined()
    }
  })
})
