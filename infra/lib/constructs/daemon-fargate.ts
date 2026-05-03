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
}

export class DaemonFargateConstruct extends Construct {
  readonly cluster: ecs.Cluster
  readonly service: ecs.FargateService | undefined
  readonly taskDefinition: ecs.FargateTaskDefinition
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

    // ----- Task definition -----
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

    // Daemon container — only added when imageDigest is present. The first
    // CDK pass before the image is pushed creates everything else; the
    // second pass after the image is published wires the container.
    if (props.imageDigest !== undefined) {
      const container = this.taskDefinition.addContainer('daemon', {
        image: ecs.ContainerImage.fromEcrRepository(this.repository, props.imageDigest),
        containerName: 'orbital-daemon',
        essential: true,
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

      // RDS Proxy ingress — allow the daemon SG into the proxy.
      // The lambdaSg is already in the proxy ingress; we add daemonSg too.
      props.lambdaSg.connections.allowFrom(
        this.daemonSg,
        ec2.Port.tcp(5432),
        'Daemon connect to Aurora via RDS Proxy',
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
