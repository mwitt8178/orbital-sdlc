/**
 * daemon-fargate.ts — Long-running orchestrator daemon on ECS Fargate.
 *
 * Responsibilities provisioned here:
 *   - ECR repository for the daemon image (digest-pinned reference)
 *   - ECS cluster (or accept an existing one if shared with future services)
 *   - Fargate Task Definition: 2 vCPU / 4 GB, ARM64
 *   - IAM task role with the rights the daemon actually needs
 *   - EFS file system + access point at /var/orbital — survives task restart
 *   - SQS work queue + DLQ for daemon-targeted SNS messages
 *   - CloudWatch log group with structured-log retention
 *   - Service definition: 1 task in steady state, autoscale 1→3 on memory
 *   - X-Ray daemon as sidecar container
 *
 * The daemon is internal only — no public ALB. Health probe on :3000/health
 * is consumed by ECS for deployment circuit-breaker only.
 *
 * Phase 2.4 / 2.5 / 2.6 / 2.7 / 2.8 of the migration plan are all
 * bundled in this construct.
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as ecs from 'aws-cdk-lib/aws-ecs'
import * as ecr from 'aws-cdk-lib/aws-ecr'
import * as efs from 'aws-cdk-lib/aws-efs'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as sns from 'aws-cdk-lib/aws-sns'
import * as snsSubs from 'aws-cdk-lib/aws-sns-subscriptions'
import * as sqs from 'aws-cdk-lib/aws-sqs'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'

export interface DaemonFargateProps {
  readonly envName: string
  readonly vpc: ec2.IVpc
  readonly lambdaSg: ec2.ISecurityGroup
  readonly rdsProxy: rds.DatabaseProxy
  readonly proxyEndpoint: string
  readonly logRetentionDays: number
  /** SNS topic the daemon subscribes to via SQS for work signals. */
  readonly eventsTopic: sns.ITopic
  /** ECR image tag/digest. If undefined, the construct creates the repo
   * but doesn't reference an image — useful for first-time provisioning
   * before the image is pushed. */
  readonly imageDigest?: string
  /** Secret ARN env vars injected on the daemon container. Caller wires
   * the matching IAM grants on the task role via `taskRole`. */
  readonly secretEnvVars?: Record<string, string>
  /**
   * Secrets Manager–backed env vars. Each entry maps an env-var name to a
   * Secrets Manager secret ARN; the value is injected via ECS `secrets:` so
   * it never appears in the task definition body or CloudTrail. The task's
   * execution role is automatically granted GetSecretValue on each ARN.
   */
  readonly secretsFromManager?: Record<string, string>
  /**
   * ARN of the story-pr-pipeline Lambda. When set, the sprint-tick worker will
   * invoke it (async) for each ready story it picks up. When not set, the worker
   * logs a clear NOT_MERGED error and skips spawning — no fake success.
   * [Engineer-Sr · Sonnet · run-sprint-loop]
   */
  readonly storyPrPipelineLambdaArn?: string
}

export class DaemonFargateConstruct extends Construct {
  readonly cluster: ecs.Cluster
  readonly service: ecs.FargateService | undefined
  readonly taskDefinition: ecs.FargateTaskDefinition | undefined
  readonly repository: ecr.Repository
  readonly fileSystem: efs.FileSystem
  readonly accessPoint: efs.AccessPoint
  readonly workQueue: sqs.Queue
  readonly workDlq: sqs.Queue
  readonly logGroup: logs.LogGroup
  readonly daemonSg: ec2.SecurityGroup
  readonly taskRole: iam.Role
  readonly executionRole: iam.Role

  constructor(scope: Construct, id: string, props: DaemonFargateProps) {
    super(scope, id)
    const isProd = props.envName === 'prod'

    // ----- ECR repo -----
    this.repository = new ecr.Repository(this, 'Repo', {
      repositoryName: `orbital-${props.envName}-daemon`,
      imageScanOnPush: true,
      imageTagMutability: ecr.TagMutability.IMMUTABLE,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        { maxImageCount: 10, description: 'Retain last 10 images' },
      ],
    })

    // ----- Log group -----
    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/orbital/${props.envName}/daemon`,
      retention: props.logRetentionDays as logs.RetentionDays,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    // ----- ECS cluster -----
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `orbital-${props.envName}-daemon`,
      vpc: props.vpc,
      containerInsights: true,
      enableFargateCapacityProviders: true,
    })

    // ----- Security group for the daemon task -----
    this.daemonSg = new ec2.SecurityGroup(this, 'TaskSg', {
      vpc: props.vpc,
      securityGroupName: `orbital-${props.envName}-daemon`,
      description: `Orbital ${props.envName} daemon Fargate task SG`,
      allowAllOutbound: true,
    })
    // The daemon connects to the RDS Proxy through the existing lambdaSg
    // ingress rule; granting connect via grantConnect below adds IAM but
    // the network ACL must permit it. We add an ingress rule from this SG
    // to the proxy SG so the proxy accepts the daemon's connections.
    // Done via cross-SG allow at the proxy SG level — we expose only the
    // SG ID outward and let the proxy SG be updated by orbital-hub-stack.

    // ----- EFS file system at /var/orbital -----
    this.fileSystem = new efs.FileSystem(this, 'EfsFs', {
      vpc: props.vpc,
      fileSystemName: `orbital-${props.envName}-daemon-state`,
      encrypted: true,
      enableAutomaticBackups: isProd,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_30_DAYS,
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      securityGroup: new ec2.SecurityGroup(this, 'EfsSg', {
        vpc: props.vpc,
        securityGroupName: `orbital-${props.envName}-daemon-efs`,
        description: 'EFS for orchestrator daemon state',
        allowAllOutbound: false,
      }),
    })
    this.fileSystem.connections.allowDefaultPortFrom(this.daemonSg)

    // EFS access point pinned to the orbital UID/GID baked into the
    // Dockerfile (10001). This way we don't need root inside the
    // container to mount/write the EFS path.
    this.accessPoint = new efs.AccessPoint(this, 'EfsAccessPoint', {
      fileSystem: this.fileSystem,
      path: '/orbital',
      createAcl: {
        ownerUid: '10001',
        ownerGid: '10001',
        permissions: '0750',
      },
      posixUser: {
        uid: '10001',
        gid: '10001',
      },
    })

    // ----- SQS work queue + DLQ -----
    this.workDlq = new sqs.Queue(this, 'WorkDlq', {
      queueName: `orbital-${props.envName}-daemon-work-dlq`,
      retentionPeriod: cdk.Duration.days(14),
      encryption: sqs.QueueEncryption.SQS_MANAGED,
    })
    this.workQueue = new sqs.Queue(this, 'WorkQueue', {
      queueName: `orbital-${props.envName}-daemon-work`,
      visibilityTimeout: cdk.Duration.seconds(360), // 6 min — daemon may take time per msg
      retentionPeriod: cdk.Duration.days(4),
      receiveMessageWaitTime: cdk.Duration.seconds(20), // long-poll
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      deadLetterQueue: {
        maxReceiveCount: 5,
        queue: this.workDlq,
      },
    })

    // SNS → SQS subscription with filter policy targeting the daemon.
    props.eventsTopic.addSubscription(
      new snsSubs.SqsSubscription(this.workQueue, {
        rawMessageDelivery: true,
        filterPolicy: {
          consumer: sns.SubscriptionFilter.stringFilter({ allowlist: ['daemon'] }),
        },
      }),
    )

    // ----- IAM roles -----
    this.executionRole = new iam.Role(this, 'ExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `Orbital ${props.envName} daemon ECS execution role (image pull, log push)`,
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    })
    this.repository.grantPull(this.executionRole)
    this.logGroup.grantWrite(this.executionRole)

    this.taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `Orbital ${props.envName} daemon application role`,
    })
    // RDS IAM auth
    props.rdsProxy.grantConnect(this.taskRole, 'orbital_admin')
    // SQS consume
    this.workQueue.grantConsumeMessages(this.taskRole)
    // SNS publish to events topic
    props.eventsTopic.grantPublish(this.taskRole)
    // X-Ray
    this.taskRole.addToPolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        actions: ['xray:PutTraceSegments', 'xray:PutTelemetryRecords'],
        resources: ['*'],
      }),
    )
    // CloudWatch Logs (in addition to execution role)
    this.logGroup.grantWrite(this.taskRole)
    // EFS mount
    this.fileSystem.grant(this.taskRole, 'elasticfilesystem:ClientMount', 'elasticfilesystem:ClientWrite')
    // story-pr-pipeline Lambda invoke (when ARN is wired)
    // [Engineer-Sr · Sonnet · run-sprint-loop]
    if (props.storyPrPipelineLambdaArn) {
      this.taskRole.addToPolicy(
        new iam.PolicyStatement({
          actions: ['lambda:InvokeFunction'],
          resources: [props.storyPrPipelineLambdaArn],
        }),
      )
    }

    // ----- Task definition + container — only created when imageDigest is set.
    // ECS rejects a TaskDefinition without containers, so on the first pass
    // (before the operator has pushed an image) we skip both the task def and
    // the service. The ECR repo + EFS + SQS + IAM are still provisioned.
    if (props.imageDigest !== undefined) {
      this.taskDefinition = new ecs.FargateTaskDefinition(this, 'TaskDef', {
        family: `orbital-${props.envName}-daemon`,
        cpu: 2048, // 2 vCPU
        memoryLimitMiB: 4096, // 4 GB
        taskRole: this.taskRole,
        executionRole: this.executionRole,
        runtimePlatform: {
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
        },
        volumes: [
          {
            name: 'orbital-state',
            efsVolumeConfiguration: {
              fileSystemId: this.fileSystem.fileSystemId,
              authorizationConfig: {
                accessPointId: this.accessPoint.accessPointId,
                iam: 'ENABLED',
              },
              transitEncryption: 'ENABLED',
            },
          },
        ],
      })

      // Resolve secrets-manager ARNs into ecs.Secret objects and grant the
      // execution role read access on each.
      const ecsSecrets: Record<string, ecs.Secret> = {}
      for (const [envName, secretArn] of Object.entries(props.secretsFromManager ?? {})) {
        const sm = secretsmanager.Secret.fromSecretCompleteArn(
          this,
          `Secret-${envName}`,
          secretArn,
        )
        ecsSecrets[envName] = ecs.Secret.fromSecretsManager(sm)
        sm.grantRead(this.executionRole)
        sm.grantRead(this.taskRole)
      }

      const container = this.taskDefinition.addContainer('daemon', {
        image: ecs.ContainerImage.fromEcrRepository(this.repository, props.imageDigest),
        containerName: 'orbital-daemon',
        essential: true,
        secrets: Object.keys(ecsSecrets).length > 0 ? ecsSecrets : undefined,
        environment: {
          ORBITAL_DEPLOY_TARGET: 'aws',
          ORBITAL_ENV: props.envName,
          ORBITAL_HOME: '/var/orbital',
          AURORA_DB_NAME: 'orbital_hub',
          AURORA_USERNAME: 'orbital_admin',
          RDS_PROXY_HOSTNAME: props.proxyEndpoint,
          RDS_PROXY_PORT: '5432',
          DAEMON_WORK_QUEUE_URL: this.workQueue.queueUrl,
          EVENTS_TOPIC_ARN: props.eventsTopic.topicArn,
          AWS_ACCOUNT_ID: cdk.Stack.of(this).account,
          NODE_ENV: 'production',
          LOG_LEVEL: isProd ? 'info' : 'debug',
          // Sprint tick loop — interval (ms). Default 30s in production.
          // [Engineer-Sr · Sonnet · run-sprint-loop]
          SPRINT_TICK_INTERVAL_MS: isProd ? '30000' : '15000',
          // story-pr-pipeline Lambda ARN (optional). When absent the tick worker
          // surfaces a clear NOT_MERGED error instead of faking success.
          ...(props.storyPrPipelineLambdaArn
            ? { STORY_PR_PIPELINE_LAMBDA_ARN: props.storyPrPipelineLambdaArn }
            : {}),
          ...(props.secretEnvVars ?? {}),
        },
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: 'daemon',
          logGroup: this.logGroup,
          mode: ecs.AwsLogDriverMode.NON_BLOCKING,
        }),
        healthCheck: {
          command: ['CMD-SHELL', 'curl -fsS http://localhost:3000/health || exit 1'],
          interval: cdk.Duration.seconds(20),
          timeout: cdk.Duration.seconds(5),
          startPeriod: cdk.Duration.seconds(60),
          retries: 3,
        },
        portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
        readonlyRootFilesystem: true,
      })

      container.addMountPoints({
        sourceVolume: 'orbital-state',
        containerPath: '/var/orbital',
        readOnly: false,
      })

      // X-Ray sidecar
      const xrayContainer = this.taskDefinition.addContainer('xray-daemon', {
        image: ecs.ContainerImage.fromRegistry('public.ecr.aws/xray/aws-xray-daemon:latest'),
        essential: false,
        cpu: 32,
        memoryLimitMiB: 256,
        portMappings: [
          { containerPort: 2000, protocol: ecs.Protocol.UDP },
        ],
        logging: ecs.LogDrivers.awsLogs({
          streamPrefix: 'xray',
          logGroup: this.logGroup,
        }),
      })
      // Ensure the X-Ray sidecar can write traces — execution role already
      // has cwlogs; task role already has xray:PutTrace*.
      xrayContainer.addContainerDependencies({
        container,
        condition: ecs.ContainerDependencyCondition.START,
      })

      this.service = new ecs.FargateService(this, 'Service', {
        serviceName: `orbital-${props.envName}-daemon`,
        cluster: this.cluster,
        taskDefinition: this.taskDefinition,
        desiredCount: 1,
        minHealthyPercent: 0, // daemon is single-instance; allow drop during deploy
        maxHealthyPercent: 200,
        vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
        securityGroups: [this.daemonSg],
        assignPublicIp: false,
        enableExecuteCommand: !isProd, // ECS Exec for non-prod debugging
        circuitBreaker: { rollback: true },
        deploymentController: { type: ecs.DeploymentControllerType.ECS },
      })

      // RDS Proxy ingress — allow the daemon SG INTO the proxy itself,
      // not just into the lambdaSg. The proxy's own SG accepts traffic
      // from the lambdaSg by construction (via 8-02); we add a parallel
      // rule for the daemonSg.
      props.rdsProxy.connections.allowFrom(
        this.daemonSg,
        ec2.Port.tcp(5432),
        'Daemon connect to RDS Proxy',
      )
    }

    new cdk.CfnOutput(this, 'EcrRepoUri', {
      value: this.repository.repositoryUri,
      description: `Orbital ${props.envName} daemon ECR repository URI (push images here)`,
      exportName: `OrbitalHub-${props.envName}-DaemonEcrUri`,
    })
    new cdk.CfnOutput(this, 'WorkQueueUrl', {
      value: this.workQueue.queueUrl,
      description: `Orbital ${props.envName} daemon SQS work queue URL`,
      exportName: `OrbitalHub-${props.envName}-DaemonWorkQueueUrl`,
    })

    cdk.Tags.of(this).add('orbital:component', 'daemon-fargate')
  }
}
