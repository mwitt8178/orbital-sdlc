// [Engineer-Sr · Sonnet · run-round8-05-event-bus]
/**
 * event-bus.ts - SNS + SQS + EventBridge construct for Orbital Hub.
 *
 * Provisions:
 *  - SNS topic `orbital-events-${env}` (KMS encrypted)
 *  - 4 SQS consumer queues (memory-recorder, defect-router, audit-indexer, replay-recorder)
 *    each with a DLQ + DLQ depth alarm
 *  - SNS subscription filter policies per consumer
 *  - SNS Lambda subscription to the 8-04 ws-fanout Lambda (no filter - all events)
 *  - EventBridge bus `orbital-${env}`
 *  - 3 EventBridge Scheduler rules (sprint-planning, retro-runner, hygiene-sweep)
 *
 * The caller (OrbitalHubStack) must:
 *  - Pass the wsFanoutFn (from 8-04) so we can add an SNS Lambda subscription
 *  - Pass the consumer Lambda functions so we can create SQS event source mappings
 *  - Inject EVENTS_TOPIC_ARN into any Lambda that publishes events
 */

import * as cdk from 'aws-cdk-lib'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as events from 'aws-cdk-lib/aws-events'
import * as eventsTargets from 'aws-cdk-lib/aws-events-targets'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions'
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources'
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions'
import { Construct } from 'constructs'

// ---------------------------------------------------------------------------
// Consumer names
// ---------------------------------------------------------------------------

export type ConsumerName = 'memory-recorder' | 'defect-router' | 'audit-indexer' | 'replay-recorder'

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface EventBusProps {
  /** Environment name - used in all resource names. */
  readonly envName: string
  /**
   * 8-04 ws-fanout Lambda. Subscribed to SNS topic with NO filter policy
   * (receives all events for connection-based matching).
   */
  readonly wsFanoutFn: lambda.IFunction
  /**
   * Consumer Lambda functions keyed by consumer name.
   * Each Lambda is wired to its SQS queue via an event source mapping.
   */
  readonly consumerFns: Record<ConsumerName, lambda.IFunction>
  /**
   * Scheduled Lambda functions.
   */
  readonly sprintPlanningFn: lambda.IFunction
  readonly retroRunnerFn: lambda.IFunction
  readonly hygieneSweepFn: lambda.IFunction
  /**
   * SNS alert topic for DLQ alarms (typically the ops/alerts SNS topic).
   * If not provided, DLQ alarms only produce CW metrics (no SNS notification).
   */
  readonly alertTopicArn?: string
}

// ---------------------------------------------------------------------------
// Construct
// ---------------------------------------------------------------------------

/**
 * EventBusConstruct - the 8-05 event bus layer.
 *
 * Exposes:
 *  - `snsTopic` - the main event SNS topic
 *  - `eventBridge` - the EventBridge bus
 *  - `consumerQueues` - map of ConsumerName → SQS queue
 */
export class EventBusConstruct extends Construct {
  /** The main SNS topic for Orbital events. */
  readonly snsTopic: sns.Topic

  /**
   * The KMS key used to encrypt the SQS consumer queues, DLQs, and the
   * scheduled-Lambda DLQs. Kept on a separate key from the SNS topic to
   * break the CloudFormation circular dependency that would otherwise form
   * when CDK's SqsSubscription auto-injects an `aws:SourceArn` condition
   * referencing the topic onto the queue's `encryptionMasterKey`. If the
   * topic and the queues shared the same key, that policy entry would
   * point Key → Topic while Topic → Key (via KmsMasterKeyId) - a cycle.
   */
  readonly encryptionKey: kms.Key

  /**
   * The KMS key used to encrypt the SNS topic. Separate from `encryptionKey`
   * so that no resource-policy on this key references the SNS topic ARN.
   * See `encryptionKey` doc for why this split is required.
   */
  readonly snsEncryptionKey: kms.Key

  /** The EventBridge event bus. */
  readonly eventBridge: events.EventBus

  /** SQS consumer queues, keyed by consumer name. */
  readonly consumerQueues: Record<ConsumerName, sqs.Queue>

  /** DLQs keyed by consumer name. */
  readonly dlqs: Record<ConsumerName, sqs.Queue>

  constructor(scope: Construct, id: string, props: EventBusProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY

    // ------------------------------------------------------------------
    // KMS keys - split into two to avoid a CloudFormation circular
    // dependency. CDK's SqsSubscription adds an `aws:SourceArn = topic.arn`
    // condition to the queue's encryptionMasterKey policy. If that key is
    // also the SNS topic's masterKey, we get:
    //   Topic → Key (KmsMasterKeyId GetAtt)
    //   Key   → Topic (Ref in policy condition)
    // which CFN rejects on deploy. Splitting the keys breaks the cycle.
    // ------------------------------------------------------------------

    // (1) SNS-side key: encrypts the SNS topic only. No resource policy
    //     entries reference any other Orbital resource - so no cycle source.
    this.snsEncryptionKey = new kms.Key(this, 'SnsKey', {
      alias: `orbital-${props.envName}-event-bus-sns`,
      description: `Orbital ${props.envName} - SNS topic encryption key`,
      enableKeyRotation: true,
      removalPolicy,
    })

    // (2) SQS-side key: encrypts SQS consumer queues, their DLQs, and the
    //     scheduled-Lambda DLQs. CDK's SqsSubscription will add the
    //     SourceArn-restricted SNS service grant to *this* key, producing
    //     SqsKey → SnsTopic → SnsKey, which is acyclic.
    this.encryptionKey = new kms.Key(this, 'EventBusKey', {
      alias: `orbital-${props.envName}-event-bus`,
      description: `Orbital ${props.envName} - SQS queues + DLQs encryption key`,
      enableKeyRotation: true,
      removalPolicy,
    })

    // Allow EventBridge Scheduler to use the SQS-side key for the scheduled
    // Lambda DLQs (sprint-planning, retro-runner, hygiene-sweep). Scheduler
    // delivers retry payloads to those DLQs.
    this.encryptionKey.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowEventBridgeScheduler',
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('scheduler.amazonaws.com')],
        actions: ['kms:GenerateDataKey*', 'kms:Decrypt'],
        resources: ['*'],
      }),
    )

    // ------------------------------------------------------------------
    // SNS topic: orbital-events-${env}
    // ------------------------------------------------------------------
    this.snsTopic = new sns.Topic(this, 'SnsTopic', {
      topicName: `orbital-events-${props.envName}`,
      displayName: `Orbital ${props.envName} events`,
      masterKey: this.snsEncryptionKey,
    })

    // ------------------------------------------------------------------
    // Optional alert topic for DLQ alarms
    // ------------------------------------------------------------------
    const alertTopic = props.alertTopicArn
      ? sns.Topic.fromTopicArn(this, 'AlertTopic', props.alertTopicArn)
      : null

    // ------------------------------------------------------------------
    // Consumer queues + DLQs
    // ------------------------------------------------------------------
    const consumerNames: ConsumerName[] = [
      'memory-recorder',
      'defect-router',
      'audit-indexer',
      'replay-recorder',
    ]

    this.consumerQueues = {} as Record<ConsumerName, sqs.Queue>
    this.dlqs = {} as Record<ConsumerName, sqs.Queue>

    // SNS filter policies per consumer
    const filterPolicies: Record<ConsumerName, sns.SubscriptionFilter> = {
      'memory-recorder': sns.SubscriptionFilter.stringFilter({
        allowlist: ['MemoryEntryRecorded', 'MemoryRetrievedForBrief'],
      }),
      'defect-router': sns.SubscriptionFilter.stringFilter({
        allowlist: ['DefectReported'],
      }),
      'audit-indexer': sns.SubscriptionFilter.existsFilter(),
      'replay-recorder': sns.SubscriptionFilter.stringFilter({
        allowlist: ['ReplayCaptureCompleted'],
      }),
    }

    for (const name of consumerNames) {
      // DLQ
      const dlq = new sqs.Queue(this, `${pascalCase(name)}Dlq`, {
        queueName: `orbital-${props.envName}-${name}-dlq`,
        encryptionMasterKey: this.encryptionKey,
        retentionPeriod: cdk.Duration.days(14),
        removalPolicy,
      })
      this.dlqs[name] = dlq

      // Consumer queue
      const queue = new sqs.Queue(this, `${pascalCase(name)}Queue`, {
        queueName: `orbital-${props.envName}-${name}`,
        encryptionMasterKey: this.encryptionKey,
        visibilityTimeout: cdk.Duration.seconds(60),
        retentionPeriod: cdk.Duration.days(4),
        deadLetterQueue: {
          queue: dlq,
          maxReceiveCount: 3,
        },
        removalPolicy,
      })
      this.consumerQueues[name] = queue

      // Grant the SNS topic permission to send to this queue
      queue.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowSnsPublish',
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal('sns.amazonaws.com')],
          actions: ['sqs:SendMessage'],
          resources: [queue.queueArn],
          conditions: {
            ArnEquals: { 'aws:SourceArn': this.snsTopic.topicArn },
          },
        }),
      )

      // SNS → SQS subscription with filter policy
      this.snsTopic.addSubscription(
        new subscriptions.SqsSubscription(queue, {
          rawMessageDelivery: false,
          filterPolicy: {
            event_type: filterPolicies[name],
          },
        }),
      )

      // SQS → Lambda event source mapping (batch 10, max batching window 5s)
      const consumerFn = props.consumerFns[name]
      consumerFn.addEventSource(
        new lambdaEventSources.SqsEventSource(queue, {
          batchSize: 10,
          maxBatchingWindow: cdk.Duration.seconds(5),
          reportBatchItemFailures: true,
        }),
      )

      // DLQ depth alarm - alert when any message lands in DLQ
      const dlqAlarm = new cloudwatch.Alarm(this, `${pascalCase(name)}DlqAlarm`, {
        alarmName: `orbital-${props.envName}-${name}-dlq-depth`,
        alarmDescription: `DLQ for ${name} consumer has messages - check for processing failures`,
        metric: dlq.metricApproximateNumberOfMessagesVisible({
          period: cdk.Duration.minutes(1),
          statistic: 'Maximum',
        }),
        threshold: 0,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      })

      if (alertTopic) {
        dlqAlarm.addAlarmAction(new cloudwatchActions.SnsAction(alertTopic))
      }
    }

    // ------------------------------------------------------------------
    // SNS → ws-fanout Lambda subscription (NO filter - all events)
    // ------------------------------------------------------------------
    this.snsTopic.addSubscription(
      new subscriptions.LambdaSubscription(props.wsFanoutFn as lambda.Function),
    )

    // ------------------------------------------------------------------
    // EventBridge bus: orbital-${env}
    // ------------------------------------------------------------------
    this.eventBridge = new events.EventBus(this, 'EventBus', {
      eventBusName: `orbital-${props.envName}`,
    })

    // ------------------------------------------------------------------
    // EventBridge Scheduler rules
    //
    // NOTE: AWS EventBridge schedule-based rules (cron/rate) MUST use the
    // default event bus. Custom event buses only support pattern-matched rules.
    // The custom bus `orbital-${env}` is used for pattern-match event routing;
    // scheduled Lambda invocations use the default bus as required by AWS.
    // ------------------------------------------------------------------

    // Sprint planning: cron(0 9 * * ? *) - 9am UTC every day
    const sprintPlanningRule = new events.Rule(this, 'SprintPlanningRule', {
      ruleName: `sprint-planning-${props.envName}`,
      description: `Orbital ${props.envName} - trigger per-tenant 9am sprint-planning ceremony check`,
      // No eventBus property: uses default event bus (required for schedule)
      schedule: events.Schedule.cron({ minute: '0', hour: '9' }),
      enabled: true,
    })
    sprintPlanningRule.addTarget(new eventsTargets.LambdaFunction(props.sprintPlanningFn, {
      retryAttempts: 2,
      deadLetterQueue: new sqs.Queue(this, 'SprintPlanningDlq', {
        queueName: `orbital-${props.envName}-sprint-planning-dlq`,
        encryptionMasterKey: this.encryptionKey,
        retentionPeriod: cdk.Duration.days(14),
        removalPolicy,
      }),
    }))

    // Retro runner: cron(0 17 * * ? *) - 5pm UTC every day
    const retroRunnerRule = new events.Rule(this, 'RetroRunnerRule', {
      ruleName: `retro-runner-${props.envName}`,
      description: `Orbital ${props.envName} - trigger per-tenant 5pm retro ceremony check`,
      // No eventBus property: uses default event bus (required for schedule)
      schedule: events.Schedule.cron({ minute: '0', hour: '17' }),
      enabled: true,
    })
    retroRunnerRule.addTarget(new eventsTargets.LambdaFunction(props.retroRunnerFn, {
      retryAttempts: 2,
      deadLetterQueue: new sqs.Queue(this, 'RetroRunnerDlq', {
        queueName: `orbital-${props.envName}-retro-runner-dlq`,
        encryptionMasterKey: this.encryptionKey,
        retentionPeriod: cdk.Duration.days(14),
        removalPolicy,
      }),
    }))

    // Hygiene sweep: rate(1 hour) - every hour
    const hygieneSweepRule = new events.Rule(this, 'HygieneSweepRule', {
      ruleName: `hygiene-sweep-${props.envName}`,
      description: `Orbital ${props.envName} - hourly stale worker + expired session cleanup`,
      // No eventBus property: uses default event bus (required for rate/schedule)
      schedule: events.Schedule.rate(cdk.Duration.hours(1)),
      enabled: true,
    })
    hygieneSweepRule.addTarget(new eventsTargets.LambdaFunction(props.hygieneSweepFn, {
      retryAttempts: 2,
      deadLetterQueue: new sqs.Queue(this, 'HygieneSweepDlq', {
        queueName: `orbital-${props.envName}-hygiene-sweep-dlq`,
        encryptionMasterKey: this.encryptionKey,
        retentionPeriod: cdk.Duration.days(14),
        removalPolicy,
      }),
    }))

    // ------------------------------------------------------------------
    // Stack outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'SnsTopicArn', {
      value: this.snsTopic.topicArn,
      description: `Orbital ${props.envName} events SNS topic ARN`,
      exportName: `OrbitalHub-${props.envName}-EventsTopicArn`,
    })

    new cdk.CfnOutput(this, 'EventBusName', {
      value: this.eventBridge.eventBusName,
      description: `Orbital ${props.envName} EventBridge bus name`,
      exportName: `OrbitalHub-${props.envName}-EventBusName`,
    })

    cdk.Tags.of(this).add('orbital:component', 'event-bus')
  }

  /**
   * Grant publish rights to a Lambda/role that needs to publish to the SNS topic.
   * Grants sns:Publish + kms:GenerateDataKey/Decrypt on the SNS-side topic key.
   * Publishers do not need permission on the SQS-side key - SNS handles the
   * envelope re-encryption when delivering to subscribed queues.
   */
  grantPublish(grantee: iam.IGrantable): void {
    this.snsTopic.grantPublish(grantee)
    this.snsEncryptionKey.grantEncryptDecrypt(grantee)
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert kebab-case to PascalCase for CDK logical IDs. */
function pascalCase(s: string): string {
  return s.replace(/(^|-)([a-z])/g, (_, _sep, char: string) => char.toUpperCase())
}
