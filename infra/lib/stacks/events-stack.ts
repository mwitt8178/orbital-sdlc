/**
 * events-stack.ts — SNS topic, SQS consumer queues + DLQs, EventBridge rules,
 * event-worker (consumer + scheduled) Lambdas, plus the cross-cutting SNS
 * grants to api-lambda, install-lambda, daemon, and fanout.
 *
 * Phase 4 stack split: resources are instantiated directly on the parent scope
 * so logical IDs stay identical to the monolith.
 */
import * as cdk from 'aws-cdk-lib'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as path from 'path'
import { Construct } from 'constructs'
import { EventBusConstruct, type ConsumerName } from '../constructs/event-bus'
import { ApiLambdaConstruct } from '../constructs/api-lambda'
import { LambdaTrpcConstruct, RouterGroup } from '../constructs/lambda-trpc'
import { EnvConfig } from '../orbital-hub-stack'

export interface EventsOutputs {
  readonly eventBus: EventBusConstruct
  readonly consumerFns: Record<ConsumerName, lambda.Function>
  readonly scheduledFns: Record<string, lambda.Function>
}

/**
 * Provision event-bus resources (SNS, SQS, EventBridge, consumer/scheduled Lambdas)
 * directly on the given scope, then wire SNS publish grants to API lambdas.
 * Daemon SNS grants are applied in daemon-stack after the daemon is created.
 */
export function buildEventsResources(
  scope: Construct,
  envName: string,
  envConfig: EnvConfig,
  wsFanoutFn: lambda.Function,
  apiLambda: ApiLambdaConstruct,
  installLambdaMap: Map<RouterGroup, LambdaTrpcConstruct>,
): EventsOutputs {
  const isProd = envName === 'prod'

  const orchestratorDist = path.resolve(
    __dirname,
    '../../../packages/orchestrator/dist',
  )

  // Consumer Lambda functions — one per SQS queue
  const consumerHandlers: Record<ConsumerName, string> = {
    'memory-recorder': 'lambda/consumers/memory-recorder.handler',
    'defect-router':   'lambda/consumers/defect-router.handler',
    'audit-indexer':   'lambda/consumers/audit-indexer.handler',
    'replay-recorder': 'lambda/consumers/replay-recorder.handler',
  }

  const consumerFns: Record<ConsumerName, lambda.Function> = {} as Record<ConsumerName, lambda.Function>

  for (const [consumerName, handlerPath] of Object.entries(consumerHandlers) as [ConsumerName, string][]) {
    const logGroup = new logs.LogGroup(scope, `Consumer-${consumerName}-LogGroup`, {
      logGroupName: `/orbital/${envName}/lambda/consumer-${consumerName}`,
      retention: envConfig.logRetentionDays as logs.RetentionDays,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    const role = new iam.Role(scope, `Consumer-${consumerName}-Role`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Orbital ${envName} ${consumerName} consumer Lambda execution role`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    })
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    }))

    consumerFns[consumerName] = new lambda.Function(scope, `Consumer-${consumerName}-Fn`, {
      functionName: `orbital-${envName}-consumer-${consumerName}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: handlerPath,
      code: lambda.Code.fromAsset(orchestratorDist, {
        exclude: ['**/*.test.*', '**/*.spec.*', '**/test/**'],
      }),
      role,
      timeout: cdk.Duration.seconds(60),
      memorySize: 256,
      environment: {
        ORBITAL_DEPLOY_TARGET: 'aws',
        ORBITAL_ENV: envName,
        NODE_ENV: 'production',
      },
      logGroup,
      tracing: lambda.Tracing.ACTIVE,
    })
  }

  // Scheduled Lambda functions
  const scheduledDefs: Array<{ name: string; handler: string }> = [
    { name: 'sprint-planning', handler: 'lambda/scheduled/sprint-planning.handler' },
    { name: 'retro-runner',    handler: 'lambda/scheduled/retro-runner.handler' },
    { name: 'hygiene-sweep',   handler: 'lambda/scheduled/hygiene-sweep.handler' },
  ]

  const scheduledFns: Record<string, lambda.Function> = {}

  for (const { name, handler: handlerPath } of scheduledDefs) {
    const logGroup = new logs.LogGroup(scope, `Scheduled-${name}-LogGroup`, {
      logGroupName: `/orbital/${envName}/lambda/scheduled-${name}`,
      retention: envConfig.logRetentionDays as logs.RetentionDays,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    const role = new iam.Role(scope, `Scheduled-${name}-Role`, {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      description: `Orbital ${envName} ${name} scheduled Lambda execution role`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    })
    role.addToPolicy(new iam.PolicyStatement({
      effect: iam.Effect.ALLOW,
      actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
      resources: ['*'],
    }))

    scheduledFns[name] = new lambda.Function(scope, `Scheduled-${name}-Fn`, {
      functionName: `orbital-${envName}-scheduled-${name}`,
      runtime: lambda.Runtime.NODEJS_22_X,
      handler: handlerPath,
      code: lambda.Code.fromAsset(orchestratorDist, {
        exclude: ['**/*.test.*', '**/*.spec.*', '**/test/**'],
      }),
      role,
      timeout: cdk.Duration.seconds(300),
      memorySize: 256,
      environment: {
        ORBITAL_DEPLOY_TARGET: 'aws',
        ORBITAL_ENV: envName,
        NODE_ENV: 'production',
      },
      logGroup,
      tracing: lambda.Tracing.ACTIVE,
    })
  }

  // EventBusConstruct — wires SNS, SQS, EventBridge, filter policies
  const eventBus = new EventBusConstruct(scope, 'EventBus', {
    envName,
    wsFanoutFn,
    consumerFns,
    sprintPlanningFn: scheduledFns['sprint-planning']!,
    retroRunnerFn:    scheduledFns['retro-runner']!,
    hygieneSweepFn:   scheduledFns['hygiene-sweep']!,
  })

  // Cross-cutting SNS publish grants
  apiLambda.fn.addEnvironment('EVENTS_TOPIC_ARN', eventBus.snsTopic.topicArn)
  eventBus.grantPublish(apiLambda.role)

  const installLambdaConstruct = installLambdaMap.get('tasks')!
  installLambdaConstruct.fn.addEnvironment('EVENTS_TOPIC_ARN', eventBus.snsTopic.topicArn)
  eventBus.grantPublish(installLambdaConstruct.role)

  consumerFns['defect-router'].addEnvironment('EVENTS_TOPIC_ARN', eventBus.snsTopic.topicArn)
  eventBus.grantPublish(consumerFns['defect-router'])

  wsFanoutFn.addEnvironment('EVENTS_TOPIC_ARN', eventBus.snsTopic.topicArn)

  return { eventBus, consumerFns, scheduledFns }
}
