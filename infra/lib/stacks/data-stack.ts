/**
 * data-stack.ts — Aurora cluster, RDS Proxy, migration trigger, S3 buckets.
 *
 * StaticUiConstruct is provisioned here (before ReplayBucketConstruct) to
 * preserve the construction order from the original monolith. The CDK
 * S3AutoDeleteObjects custom resource provider is a singleton whose Lambda
 * description references the FIRST bucket that triggers it — reordering
 * StaticUi vs ReplayBucket would change a CloudFormation resource description
 * and produce a spurious diff against the deployed stack.
 *
 * Phase 4 stack split: resources are instantiated directly on the parent scope
 * so logical IDs stay identical to the monolith.
 */
import * as acm from 'aws-cdk-lib/aws-certificatemanager'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as route53 from 'aws-cdk-lib/aws-route53'
import { Construct } from 'constructs'
import { AuroraConstruct } from '../constructs/aurora'
import { RdsProxyConstruct } from '../constructs/rds-proxy'
import { StaticUiConstruct } from '../constructs/static-ui'
import { ReplayBucketConstruct } from '../constructs/replay-bucket'
import { RunMigrationsTrigger } from '../triggers/run-migrations'
import { EnvConfig } from '../orbital-hub-stack'

export interface DataOutputs {
  readonly aurora: AuroraConstruct
  readonly rdsProxy: RdsProxyConstruct
  readonly staticUi: StaticUiConstruct
  readonly replayBucket: ReplayBucketConstruct
  /** The standalone proxy SG created before Aurora to break the circular SG reference. */
  readonly proxySgForAurora: ec2.SecurityGroup
}

/**
 * Provision data resources (Aurora, RDS Proxy, S3 buckets, migration trigger)
 * directly on the given scope.
 *
 * Construction order mirrors the original monolith exactly:
 *   ProxySgRef → Aurora → RdsProxy → Migrations → StaticUi → ReplayBucket
 */
export function buildDataResources(
  scope: Construct,
  envName: string,
  envConfig: EnvConfig,
  vpc: ec2.IVpc,
  certificate: acm.ICertificate | undefined,
  hostedZone: route53.IHostedZone | undefined,
): DataOutputs {
  // Standalone Proxy SG — Aurora references this; RdsProxyConstruct reuses it.
  // Construction order: ProxySgRef → Aurora (uses SG) → RdsProxy (owns SG).
  const proxySgForAurora = new ec2.SecurityGroup(scope, 'ProxySgRef', {
    vpc,
    securityGroupName: `orbital-${envName}-rds-proxy`,
    description: `Orbital ${envName} - RDS Proxy SG (forward ref for Aurora). Managed by RdsProxyConstruct.`,
    allowAllOutbound: false,
  })

  const aurora = new AuroraConstruct(scope, 'Aurora', {
    envName,
    vpc,
    minAcu: envConfig.auroraMinAcu,
    maxAcu: envConfig.auroraMaxAcu,
    logRetentionDays: envConfig.logRetentionDays,
    allowedSg: proxySgForAurora,
  })

  const rdsProxy = new RdsProxyConstruct(scope, 'RdsProxy', {
    envName,
    vpc,
    cluster: aurora.cluster,
    masterSecret: aurora.masterSecret,
    existingProxySg: proxySgForAurora,
  })

  new RunMigrationsTrigger(scope, 'Migrations', {
    envName,
    vpc,
    proxy: rdsProxy.proxy,
    proxyEndpoint: rdsProxy.proxy.endpoint,
    cluster: aurora.cluster,
    masterSecret: aurora.masterSecret,
    lambdaSg: rdsProxy.lambdaSecurityGroup,
    logRetentionDays: envConfig.logRetentionDays,
  })

  // StaticUi MUST be created before ReplayBucket to preserve CDK singleton
  // provider description ordering (matches original monolith lines 333/342).
  const staticUi = new StaticUiConstruct(scope, 'StaticUi', {
    envName,
    domain: envConfig.domain,
    certificate,
    hostedZone,
  })

  const replayBucket = new ReplayBucketConstruct(scope, 'ReplayBucket', {
    envName,
    retentionYears: 7,
  })

  return { aurora, rdsProxy, staticUi, replayBucket, proxySgForAurora }
}
