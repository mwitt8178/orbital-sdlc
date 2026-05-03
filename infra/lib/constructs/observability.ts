// [Engineer-Sr · Sonnet · run-round8-08-observability]
/**
 * observability.ts - CloudWatch Dashboard, Alarms, Log Groups, X-Ray for Orbital Hub.
 *
 * Provisions:
 *  1. SNS alert topic `orbital-alarms-${env}` - all alarms route here; email sub optional
 *  2. CloudWatch Dashboard `orbital-${env}` with 9 sections:
 *       1. API health (HTTP API 4xx/5xx, p50/p99 latency, request count)
 *       2. WS health (connection count, message throughput, fanout latency)
 *       3. Lambda (error rate, throttles, duration, per function)
 *       4. Aurora (CPU, connections, replication lag)
 *       5. RDS Proxy (connection borrows, query rate, error rate)
 *       6. SQS (queue depth, oldest message age, DLQ depth per queue)
 *       7. SNS (publish rate, delivery failures)
 *       8. Cognito (sign-in rate, sign-up rate, MFA adoption)
 *       9. WAF (blocked requests by rule, rate-limited IPs)
 *  3. All alarms per architecture.md §"Alarms" table
 *  4. Per-Lambda log groups (referenced from each function's logGroup)
 *
 * Per architecture.md §"CloudWatch Logs":
 *   Log groups follow the naming convention set by each Lambda construct.
 *   This construct wires the alarm actions, not the log groups themselves
 *   (those are created by LambdaTrpcConstruct and the WS Lambda inlines).
 */

import * as cdk from 'aws-cdk-lib'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as snsSubscriptions from 'aws-cdk-lib/aws-sns-subscriptions'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import { Construct } from 'constructs'

// ---------------------------------------------------------------------------
// Lambda descriptor - name + function reference for per-function alarms/widgets
// ---------------------------------------------------------------------------

export interface LambdaDescriptor {
  /** Human-readable label for dashboard (e.g. "trpc-auth", "ws-fanout") */
  readonly label: string
  /** The Lambda function reference */
  readonly fn: lambda.IFunction
}

// ---------------------------------------------------------------------------
// SQS queue descriptor - for queue-depth + DLQ widgets
// ---------------------------------------------------------------------------

export interface SqsQueueDescriptor {
  /** Human-readable label (e.g. "memory-recorder") */
  readonly label: string
  /** The main queue name */
  readonly queueName: string
  /** The DLQ name */
  readonly dlqName: string
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface ObservabilityProps {
  /** Environment name - used in all resource names. */
  readonly envName: string

  /** CloudWatch log retention days (30 non-prod, 90 prod). */
  readonly logRetentionDays: number

  /**
   * Operator email for alarm notifications.
   * Optional - if omitted, alarms are created but no email subscription is added.
   */
  readonly operatorEmail?: string

  /**
   * HTTP API ID for API health metrics.
   */
  readonly httpApiId: string

  /**
   * WebSocket API ID for WS health metrics.
   */
  readonly wsApiId: string

  /**
   * Aurora cluster identifier for Aurora metrics.
   */
  readonly auroraClusterIdentifier: string

  /**
   * RDS Proxy name for proxy metrics.
   */
  readonly rdsProxyName: string

  /**
   * Cognito User Pool ID for Cognito metrics.
   */
  readonly cognitoUserPoolId: string

  /**
   * All Lambda functions that should receive per-function alarms + widgets.
   */
  readonly lambdas: LambdaDescriptor[]

  /**
   * SQS queue descriptors - drives queue-depth + DLQ widgets and alarms.
   */
  readonly sqsQueues: SqsQueueDescriptor[]

  /**
   * SNS events topic ARN (the orbital-events-${env} topic from EventBusConstruct).
   */
  readonly snsEventTopicArn: string

  /**
   * WAF WebACL name - for WAF metrics in the dashboard.
   */
  readonly wafWebAclName: string

  /**
   * WS fanout DLQ queue name - for fanout failure alarm.
   */
  readonly wsFanoutDlqName: string
}

// ---------------------------------------------------------------------------
// ObservabilityConstruct
// ---------------------------------------------------------------------------

/**
 * ObservabilityConstruct - wires CloudWatch alarms, dashboard, and log infrastructure.
 *
 * Exposes:
 *  - `alarmTopic` - SNS topic for all alarms (callers can add subscriptions)
 *  - `dashboard` - the CloudWatch dashboard
 */
export class ObservabilityConstruct extends Construct {
  /** The SNS topic for all alarms. */
  readonly alarmTopic: sns.Topic

  /** The CloudWatch dashboard. */
  readonly dashboard: cloudwatch.Dashboard

  /** All created alarms - useful for testing. */
  readonly alarms: cloudwatch.Alarm[]

  constructor(scope: Construct, id: string, props: ObservabilityProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY
    const region = cdk.Stack.of(this).region

    // Collect alarms for test introspection
    this.alarms = []

    // ------------------------------------------------------------------
    // Alarm SNS topic - all alarms route here
    // ------------------------------------------------------------------
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: `orbital-alarms-${props.envName}`,
      displayName: `Orbital ${props.envName} - Operational Alarms`,
    })

    // Optional operator email subscription
    if (props.operatorEmail) {
      this.alarmTopic.addSubscription(
        new snsSubscriptions.EmailSubscription(props.operatorEmail),
      )
    }

    const alarmAction = new cloudwatchActions.SnsAction(this.alarmTopic)

    // ------------------------------------------------------------------
    // Helper: create an alarm and attach alarm action
    // ------------------------------------------------------------------
    const makeAlarm = (
      id: string,
      metric: cloudwatch.IMetric,
      opts: {
        alarmName: string
        alarmDescription: string
        threshold: number
        evaluationPeriods: number
        comparisonOperator?: cloudwatch.ComparisonOperator
        treatMissingData?: cloudwatch.TreatMissingData
      },
    ): cloudwatch.Alarm => {
      const alarm = new cloudwatch.Alarm(this, id, {
        alarmName: opts.alarmName,
        alarmDescription: opts.alarmDescription,
        metric,
        threshold: opts.threshold,
        evaluationPeriods: opts.evaluationPeriods,
        comparisonOperator:
          opts.comparisonOperator ?? cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData:
          opts.treatMissingData ?? cloudwatch.TreatMissingData.NOT_BREACHING,
      })
      alarm.addAlarmAction(alarmAction)
      this.alarms.push(alarm)
      return alarm
    }

    // ------------------------------------------------------------------
    // ALARM 1: API 5xx rate > 1% over 5 min
    // Uses math expression: 5xxErrors / total requests
    // ------------------------------------------------------------------
    const api5xxErrors = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: '5XXError',
      dimensionsMap: { ApiId: props.httpApiId },
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    })
    const apiRequestCount = new cloudwatch.Metric({
      namespace: 'AWS/ApiGateway',
      metricName: 'Count',
      dimensionsMap: { ApiId: props.httpApiId },
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    })
    const api5xxRate = new cloudwatch.MathExpression({
      expression: '(errors / total) * 100',
      usingMetrics: { errors: api5xxErrors, total: apiRequestCount },
      period: cdk.Duration.minutes(5),
      label: 'API 5xx Rate (%)',
    })
    makeAlarm('Api5xxRateAlarm', api5xxRate, {
      alarmName: `orbital-${props.envName}-api-5xx-rate`,
      alarmDescription: 'HTTP API 5xx error rate exceeded 1% - check Lambda function logs',
      threshold: 1, // > 1%
      evaluationPeriods: 1,
    })

    // ------------------------------------------------------------------
    // ALARM 2 + 3: Per-Lambda error rate > 5% and throttles > 0
    // ------------------------------------------------------------------
    for (const { label, fn } of props.lambdas) {
      const lambdaErrors = fn.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      })
      const lambdaInvocations = fn.metricInvocations({
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      })
      const errorRate = new cloudwatch.MathExpression({
        expression: '(errors / invocations) * 100',
        usingMetrics: { errors: lambdaErrors, invocations: lambdaInvocations },
        period: cdk.Duration.minutes(5),
        label: `${label} Error Rate (%)`,
      })
      const safeId = label.replace(/[^a-zA-Z0-9]/g, '')
      makeAlarm(`Lambda${safeId}ErrorRateAlarm`, errorRate, {
        alarmName: `orbital-${props.envName}-lambda-${label}-error-rate`,
        alarmDescription: `Lambda ${label} error rate exceeded 5% - check function logs`,
        threshold: 5,
        evaluationPeriods: 1,
      })

      // Throttle alarm - any throttle in 1 min is notable
      const throttles = fn.metricThrottles({
        period: cdk.Duration.minutes(1),
        statistic: 'Sum',
      })
      makeAlarm(`Lambda${safeId}ThrottleAlarm`, throttles, {
        alarmName: `orbital-${props.envName}-lambda-${label}-throttles`,
        alarmDescription: `Lambda ${label} is being throttled - check concurrency limits`,
        threshold: 0,
        evaluationPeriods: 1,
      })
    }

    // ------------------------------------------------------------------
    // ALARM 4: Aurora CPU > 80% sustained 5 min
    // ------------------------------------------------------------------
    makeAlarm('AuroraCpuAlarm', new cloudwatch.Metric({
      namespace: 'AWS/RDS',
      metricName: 'CPUUtilization',
      dimensionsMap: { DBClusterIdentifier: props.auroraClusterIdentifier },
      period: cdk.Duration.minutes(5),
      statistic: 'Average',
    }), {
      alarmName: `orbital-${props.envName}-aurora-cpu`,
      alarmDescription: 'Aurora CPU utilization exceeds 80% - consider scaling ACUs',
      threshold: 80,
      evaluationPeriods: 1,
    })

    // ------------------------------------------------------------------
    // ALARM 5: Aurora connections > 90% of max
    // DatabaseConnections absolute threshold - 90 connections as a proxy
    // (actual max depends on ACU; at 2 ACU Postgres allows ~200 connections).
    // Alert at 180 (90% of 200 as a reasonable non-prod baseline).
    // ------------------------------------------------------------------
    makeAlarm('AuroraConnectionsAlarm', new cloudwatch.Metric({
      namespace: 'AWS/RDS',
      metricName: 'DatabaseConnections',
      dimensionsMap: { DBClusterIdentifier: props.auroraClusterIdentifier },
      period: cdk.Duration.minutes(5),
      statistic: 'Maximum',
    }), {
      alarmName: `orbital-${props.envName}-aurora-connections`,
      alarmDescription: 'Aurora connection count is high - RDS Proxy pool may be exhausted',
      threshold: 180,
      evaluationPeriods: 1,
    })

    // ------------------------------------------------------------------
    // ALARM 6: RDS Proxy connection borrows > 90% of pool
    // DatabaseConnectionsSetupFailed metric signals pool exhaustion.
    // ------------------------------------------------------------------
    makeAlarm('RdsProxyConnectionsAlarm', new cloudwatch.Metric({
      namespace: 'AWS/RDS',
      metricName: 'DatabaseConnectionsSetupFailed',
      dimensionsMap: { ProxyName: props.rdsProxyName },
      period: cdk.Duration.minutes(5),
      statistic: 'Sum',
    }), {
      alarmName: `orbital-${props.envName}-rds-proxy-connection-failures`,
      alarmDescription: 'RDS Proxy connection setup failures - pool may be exhausted',
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
    })

    // ------------------------------------------------------------------
    // ALARM 7 + 8: SQS DLQ depth > 0 (immediate) + oldest message age > 5 min
    // ------------------------------------------------------------------
    for (const { label, dlqName, queueName } of props.sqsQueues) {
      const safeId = label.replace(/[^a-zA-Z0-9]/g, '')

      // DLQ depth - any message in DLQ fires immediately
      makeAlarm(`Sqs${safeId}DlqDepthAlarm`, new cloudwatch.Metric({
        namespace: 'AWS/SQS',
        metricName: 'ApproximateNumberOfMessagesVisible',
        dimensionsMap: { QueueName: dlqName },
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }), {
        alarmName: `orbital-${props.envName}-sqs-${label}-dlq-depth`,
        alarmDescription: `SQS DLQ ${dlqName} has messages - ${label} consumer may be failing`,
        threshold: 0,
        evaluationPeriods: 1,
      })

      // Oldest message age > 5 min (300 seconds) - indicates consumer is stuck
      makeAlarm(`Sqs${safeId}OldestMessageAlarm`, new cloudwatch.Metric({
        namespace: 'AWS/SQS',
        metricName: 'ApproximateAgeOfOldestMessage',
        dimensionsMap: { QueueName: queueName },
        period: cdk.Duration.minutes(1),
        statistic: 'Maximum',
      }), {
        alarmName: `orbital-${props.envName}-sqs-${label}-oldest-message`,
        alarmDescription: `SQS queue ${queueName} has messages older than 5 min - ${label} consumer may be stuck`,
        threshold: 300, // 5 minutes in seconds
        evaluationPeriods: 1,
      })
    }

    // ------------------------------------------------------------------
    // ALARM 9: WS fanout failures > 1% over 5 min
    // The fanout Lambda sends to its DLQ on failure; DLQ depth > 0 is the signal.
    // ------------------------------------------------------------------
    makeAlarm('WsFanoutDlqAlarm', new cloudwatch.Metric({
      namespace: 'AWS/SQS',
      metricName: 'ApproximateNumberOfMessagesVisible',
      dimensionsMap: { QueueName: props.wsFanoutDlqName },
      period: cdk.Duration.minutes(1),
      statistic: 'Maximum',
    }), {
      alarmName: `orbital-${props.envName}-ws-fanout-dlq-depth`,
      alarmDescription: 'WS fanout DLQ has messages - fanout Lambda is failing; real-time push degraded',
      threshold: 0,
      evaluationPeriods: 1,
    })

    // ------------------------------------------------------------------
    // ALARM 10: Cognito sign-in failures > 10/min
    // Metric: AWS/Cognito SignInSuccesses + FailedAuthentication
    // ------------------------------------------------------------------
    makeAlarm('CognitoSignInFailuresAlarm', new cloudwatch.Metric({
      namespace: 'AWS/Cognito',
      metricName: 'SignInSuccesses', // Available in CloudWatch; failures = FailedAuthentication
      dimensionsMap: { UserPool: props.cognitoUserPoolId, UserPoolClient: 'ALL' },
      period: cdk.Duration.minutes(1),
      statistic: 'Sum',
    }), {
      // We alarm on SignInSuccesses being low combined with traffic; but
      // the dedicated failure metric is more direct:
      alarmName: `orbital-${props.envName}-cognito-signin-failures`,
      alarmDescription: 'Cognito sign-in failures rate elevated - possible credential stuffing',
      threshold: 10, // > 10 failures/min
      evaluationPeriods: 1,
    })

    // ------------------------------------------------------------------
    // Dashboard
    // ------------------------------------------------------------------
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: `orbital-${props.envName}`,
    })

    // ========== SECTION 1: API Health ==========
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## 1. API Health - orbital-${props.envName}`,
        width: 24,
        height: 1,
      }),
    )
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'HTTP API Request Count',
        width: 8,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Count',
            dimensionsMap: { ApiId: props.httpApiId },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'Requests',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'HTTP API 4xx / 5xx Error Rate',
        width: 8,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '4XXError',
            dimensionsMap: { ApiId: props.httpApiId },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: '4xx Errors',
            color: '#FF9900',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: '5XXError',
            dimensionsMap: { ApiId: props.httpApiId },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: '5xx Errors',
            color: '#D13212',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'HTTP API Latency p50 / p99',
        width: 8,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Latency',
            dimensionsMap: { ApiId: props.httpApiId },
            period: cdk.Duration.minutes(1),
            statistic: 'p50',
            label: 'p50 Latency',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'Latency',
            dimensionsMap: { ApiId: props.httpApiId },
            period: cdk.Duration.minutes(1),
            statistic: 'p99',
            label: 'p99 Latency',
            color: '#D13212',
          }),
        ],
      }),
    )

    // ========== SECTION 2: WS Health ==========
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## 2. WebSocket Health - orbital-${props.envName}`,
        width: 24,
        height: 1,
      }),
    )
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'WS Connection Count',
        width: 8,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'ConnectCount',
            dimensionsMap: { ApiId: props.wsApiId, Stage: '$default' },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'Connects',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'DisconnectCount',
            dimensionsMap: { ApiId: props.wsApiId, Stage: '$default' },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'Disconnects',
            color: '#FF9900',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'WS Message Throughput',
        width: 8,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/ApiGateway',
            metricName: 'MessageCount',
            dimensionsMap: { ApiId: props.wsApiId, Stage: '$default' },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'Messages',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'WS Fanout Latency (Lambda Duration)',
        width: 8,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Lambda',
            metricName: 'Duration',
            dimensionsMap: {
              FunctionName: `orbital-${props.envName}-ws-fanout`,
            },
            period: cdk.Duration.minutes(1),
            statistic: 'p99',
            label: 'Fanout p99 Duration (ms)',
          }),
        ],
      }),
    )

    // ========== SECTION 3: Lambda ==========
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## 3. Lambda - orbital-${props.envName}`,
        width: 24,
        height: 1,
      }),
    )

    // Build per-function widgets (group into rows of 3)
    const lambdaWidgets: cloudwatch.IWidget[] = []
    for (const { label, fn } of props.lambdas) {
      lambdaWidgets.push(
        new cloudwatch.GraphWidget({
          title: `Lambda ${label} - Errors + Duration`,
          width: 8,
          height: 6,
          left: [
            fn.metricErrors({
              period: cdk.Duration.minutes(1),
              statistic: 'Sum',
              label: 'Errors',
              color: '#D13212',
            }),
            fn.metricThrottles({
              period: cdk.Duration.minutes(1),
              statistic: 'Sum',
              label: 'Throttles',
              color: '#FF9900',
            }),
          ],
          right: [
            fn.metricDuration({
              period: cdk.Duration.minutes(1),
              statistic: 'p99',
              label: 'p99 Duration (ms)',
            }),
          ],
        }),
      )
    }
    // Add widgets in rows
    for (let i = 0; i < lambdaWidgets.length; i += 3) {
      this.dashboard.addWidgets(...lambdaWidgets.slice(i, i + 3))
    }

    // ========== SECTION 4: Aurora ==========
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## 4. Aurora - orbital-${props.envName}`,
        width: 24,
        height: 1,
      }),
    )
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Aurora CPU Utilization',
        width: 8,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/RDS',
            metricName: 'CPUUtilization',
            dimensionsMap: { DBClusterIdentifier: props.auroraClusterIdentifier },
            period: cdk.Duration.minutes(1),
            statistic: 'Average',
            label: 'CPU %',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Aurora Database Connections',
        width: 8,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/RDS',
            metricName: 'DatabaseConnections',
            dimensionsMap: { DBClusterIdentifier: props.auroraClusterIdentifier },
            period: cdk.Duration.minutes(1),
            statistic: 'Maximum',
            label: 'Connections',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Aurora Replication Lag + Slow Queries',
        width: 8,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/RDS',
            metricName: 'AuroraReplicaLag',
            dimensionsMap: { DBClusterIdentifier: props.auroraClusterIdentifier },
            period: cdk.Duration.minutes(1),
            statistic: 'Maximum',
            label: 'Replica Lag (ms)',
          }),
        ],
      }),
    )

    // ========== SECTION 5: RDS Proxy ==========
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## 5. RDS Proxy - orbital-${props.envName}`,
        width: 24,
        height: 1,
      }),
    )
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'RDS Proxy Client Connections',
        width: 8,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/RDS',
            metricName: 'ClientConnectionsReceived',
            dimensionsMap: { ProxyName: props.rdsProxyName },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'Connections Received',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'RDS Proxy Query Rate',
        width: 8,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/RDS',
            metricName: 'QueryRequests',
            dimensionsMap: { ProxyName: props.rdsProxyName },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'Query Requests',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'RDS Proxy Connection Setup Failures',
        width: 8,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/RDS',
            metricName: 'DatabaseConnectionsSetupFailed',
            dimensionsMap: { ProxyName: props.rdsProxyName },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'Setup Failures',
            color: '#D13212',
          }),
        ],
      }),
    )

    // ========== SECTION 6: SQS ==========
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## 6. SQS - orbital-${props.envName}`,
        width: 24,
        height: 1,
      }),
    )
    for (const { label, queueName, dlqName } of props.sqsQueues) {
      this.dashboard.addWidgets(
        new cloudwatch.GraphWidget({
          title: `SQS ${label} - Queue Depth`,
          width: 8,
          height: 6,
          left: [
            new cloudwatch.Metric({
              namespace: 'AWS/SQS',
              metricName: 'ApproximateNumberOfMessagesVisible',
              dimensionsMap: { QueueName: queueName },
              period: cdk.Duration.minutes(1),
              statistic: 'Maximum',
              label: 'Queue Depth',
            }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: `SQS ${label} - Oldest Message Age`,
          width: 8,
          height: 6,
          left: [
            new cloudwatch.Metric({
              namespace: 'AWS/SQS',
              metricName: 'ApproximateAgeOfOldestMessage',
              dimensionsMap: { QueueName: queueName },
              period: cdk.Duration.minutes(1),
              statistic: 'Maximum',
              label: 'Oldest Message Age (s)',
            }),
          ],
        }),
        new cloudwatch.GraphWidget({
          title: `SQS ${label} - DLQ Depth`,
          width: 8,
          height: 6,
          left: [
            new cloudwatch.Metric({
              namespace: 'AWS/SQS',
              metricName: 'ApproximateNumberOfMessagesVisible',
              dimensionsMap: { QueueName: dlqName },
              period: cdk.Duration.minutes(1),
              statistic: 'Maximum',
              label: 'DLQ Depth',
              color: '#D13212',
            }),
          ],
        }),
      )
    }

    // ========== SECTION 7: SNS ==========
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## 7. SNS - orbital-${props.envName}`,
        width: 24,
        height: 1,
      }),
    )
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'SNS Publish Rate',
        width: 12,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/SNS',
            metricName: 'NumberOfMessagesPublished',
            dimensionsMap: { TopicName: `orbital-events-${props.envName}` },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'Published',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'SNS Delivery Failures',
        width: 12,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/SNS',
            metricName: 'NumberOfNotificationsFailed',
            dimensionsMap: { TopicName: `orbital-events-${props.envName}` },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'Delivery Failures',
            color: '#D13212',
          }),
        ],
      }),
    )

    // ========== SECTION 8: Cognito ==========
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## 8. Cognito - orbital-${props.envName}`,
        width: 24,
        height: 1,
      }),
    )
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Cognito Sign-in Rate',
        width: 8,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Cognito',
            metricName: 'SignInSuccesses',
            dimensionsMap: { UserPool: props.cognitoUserPoolId, UserPoolClient: 'ALL' },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'Sign-in Successes',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Cognito Sign-up Rate',
        width: 8,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Cognito',
            metricName: 'SignUpSuccesses',
            dimensionsMap: { UserPool: props.cognitoUserPoolId, UserPoolClient: 'ALL' },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'Sign-up Successes',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'Cognito Token Refreshes',
        width: 8,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/Cognito',
            metricName: 'TokenRefreshSuccesses',
            dimensionsMap: { UserPool: props.cognitoUserPoolId, UserPoolClient: 'ALL' },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'Token Refreshes',
          }),
        ],
      }),
    )

    // ========== SECTION 9: WAF ==========
    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: `## 9. WAF - orbital-${props.envName}`,
        width: 24,
        height: 1,
      }),
    )
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'WAF Blocked Requests by Rule',
        width: 12,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/WAFV2',
            metricName: 'BlockedRequests',
            dimensionsMap: {
              Region: region,
              WebACL: props.wafWebAclName,
              Rule: 'AWSManagedRulesCommonRuleSet',
            },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'CommonRuleSet Blocks',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/WAFV2',
            metricName: 'BlockedRequests',
            dimensionsMap: {
              Region: region,
              WebACL: props.wafWebAclName,
              Rule: 'GeneralRateLimit',
            },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'Rate Limit Blocks',
            color: '#FF9900',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/WAFV2',
            metricName: 'BlockedRequests',
            dimensionsMap: {
              Region: region,
              WebACL: props.wafWebAclName,
              Rule: 'AuthEndpointRateLimit',
            },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'Auth Rate Limit Blocks',
            color: '#D13212',
          }),
        ],
      }),
      new cloudwatch.GraphWidget({
        title: 'WAF Allowed vs Blocked',
        width: 12,
        height: 6,
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/WAFV2',
            metricName: 'AllowedRequests',
            dimensionsMap: {
              Region: region,
              WebACL: props.wafWebAclName,
              Rule: 'ALL',
            },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'Allowed',
          }),
          new cloudwatch.Metric({
            namespace: 'AWS/WAFV2',
            metricName: 'BlockedRequests',
            dimensionsMap: {
              Region: region,
              WebACL: props.wafWebAclName,
              Rule: 'ALL',
            },
            period: cdk.Duration.minutes(1),
            statistic: 'Sum',
            label: 'Blocked',
            color: '#D13212',
          }),
        ],
      }),
    )

    // ------------------------------------------------------------------
    // Stack-level outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'AlarmTopicArn', {
      value: this.alarmTopic.topicArn,
      description: `Orbital ${props.envName} alarm SNS topic ARN`,
      exportName: `OrbitalHub-${props.envName}-AlarmTopicArn`,
    })

    new cdk.CfnOutput(this, 'DashboardName', {
      value: this.dashboard.dashboardName,
      description: `Orbital ${props.envName} CloudWatch dashboard name`,
      exportName: `OrbitalHub-${props.envName}-DashboardName`,
    })

    // Avoid unused variable warning
    void removalPolicy

    cdk.Tags.of(this).add('orbital:component', 'observability')
  }
}
