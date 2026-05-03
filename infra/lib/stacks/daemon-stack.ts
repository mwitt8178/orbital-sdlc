/**
 * daemon-stack.ts — ECS cluster, Fargate service, EFS, ECR repo, task IAM.
 *
 * Phase 4 stack split: resources are instantiated directly on the parent scope
 * so logical IDs stay identical to the monolith.
 */
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as sns from 'aws-cdk-lib/aws-sns'
import { Construct } from 'constructs'
import { DaemonFargateConstruct } from '../constructs/daemon-fargate'
import { SecretsConstruct, SecretRef, secretName } from '../constructs/secrets'
import { PerTenantKmsConstruct } from '../constructs/per-tenant-kms'
import { ReplayBucketConstruct } from '../constructs/replay-bucket'
import { secretEnvVarName, secretNameEnvVar, secretArnFor } from './secret-helpers'
import { EnvConfig } from '../orbital-hub-stack'

export interface DaemonOutputs {
  readonly daemon: DaemonFargateConstruct
}

/**
 * Provision the orchestrator daemon (ECS Fargate) directly on the given scope.
 * Must be called AFTER buildEventsResources so the SNS topic exists.
 */
export function buildDaemonResources(
  scope: Construct,
  envName: string,
  envConfig: EnvConfig,
  vpc: ec2.IVpc,
  lambdaSg: ec2.ISecurityGroup,
  rdsProxyInstance: rds.DatabaseProxy,
  proxyEndpoint: string,
  eventsTopic: sns.ITopic,
  secrets: SecretsConstruct,
  perTenantKms: PerTenantKmsConstruct,
  replayBucket: ReplayBucketConstruct,
): DaemonOutputs {
  const daemonSecretRefs: SecretRef[] = ['dbMasterCreds', 'hubMasterKey', 'githubWebhookSecret']
  const daemonSecretEnvVars: Record<string, string> = {}
  for (const ref of daemonSecretRefs) {
    daemonSecretEnvVars[secretEnvVarName(ref)] = secretArnFor(secrets, ref)
    daemonSecretEnvVars[secretNameEnvVar(ref)] = secretName(envName, ref)
  }

  const daemonImageDigest = process.env['ORBITAL_DAEMON_IMAGE_DIGEST']

  const daemon = new DaemonFargateConstruct(scope, 'Daemon', {
    envName,
    vpc,
    lambdaSg,
    rdsProxy: rdsProxyInstance,
    proxyEndpoint,
    logRetentionDays: envConfig.logRetentionDays,
    eventsTopic,
    secretEnvVars: daemonSecretEnvVars,
    ...(daemonImageDigest !== undefined ? { imageDigest: daemonImageDigest } : {}),
  })

  secrets.grantReadFor(daemon.taskRole, daemonSecretRefs)
  perTenantKms.grantPerTenantUsage(daemon.taskRole)
  perTenantKms.grantOnboardingPermissions(daemon.taskRole)
  perTenantKms.grantTenantDeletion(daemon.taskRole)
  replayBucket.bucket.grantReadWrite(daemon.taskRole)

  return { daemon }
}
