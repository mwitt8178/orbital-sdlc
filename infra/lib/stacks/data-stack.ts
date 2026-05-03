/**
 * data-stack.ts — Aurora cluster, RDS Proxy, migration trigger, S3 replay bucket.
 *
 * Phase 4 stack split: resources are instantiated directly on the parent scope
 * so logical IDs stay identical to the monolith.
 */
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { Construct } from 'constructs'
import { AuroraConstruct } from '../constructs/aurora'
import { RdsProxyConstruct } from '../constructs/rds-proxy'
import { ReplayBucketConstruct } from '../constructs/replay-bucket'
import { RunMigrationsTrigger } from '../triggers/run-migrations'
import { EnvConfig } from '../orbital-hub-stack'

export interface DataOutputs {
  readonly aurora: AuroraConstruct
  readonly rdsProxy: RdsProxyConstruct
  readonly replayBucket: ReplayBucketConstruct
  /** The standalone proxy SG created before Aurora to break the circular SG reference. */
  readonly proxySgForAurora: ec2.SecurityGroup
}

/**
 * Provision data resources (Aurora, RDS Proxy, S3 replay bucket, migration trigger)
 * directly on the given scope.
 */
export function buildDataResources(
  scope: Construct,
  envName: string,
  envConfig: EnvConfig,
  vpc: ec2.IVpc,
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

  const replayBucket = new ReplayBucketConstruct(scope, 'ReplayBucket', {
    envName,
    retentionYears: 7,
  })

  return { aurora, rdsProxy, replayBucket, proxySgForAurora }
}
