/**
 * network-stack.ts — VPC, subnets, VPC endpoints, DNS/ACM.
 *
 * Phase 4 stack split: resources are instantiated directly on the parent scope
 * (OrbitalHubStack) so CDK logical IDs remain identical to the monolith.
 * Each resource's construct path stays `OrbitalHub-<env>/Vpc`, `OrbitalHub-<env>/Dns`, etc.
 *
 * Promoting to a real CDK Stack is a future migration requiring its own
 * blast-radius analysis (logical ID prefix changes → resource recreation).
 */
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import { Construct } from 'constructs'
import { VpcConstruct } from '../constructs/vpc'
import { DnsConstruct } from '../constructs/dns'
import { EnvConfig } from '../orbital-hub-stack'

export interface NetworkOutputs {
  readonly vpc: ec2.IVpc
  readonly dns: DnsConstruct
}

/**
 * Provision network resources (VPC + DNS/ACM) directly on the given scope.
 * Using a function (not a Construct subclass) preserves construct-path
 * equivalence with the original monolith — no extra tree node is inserted.
 */
export function buildNetworkResources(
  scope: Construct,
  envName: string,
  envConfig: EnvConfig,
): NetworkOutputs {
  const vpcConstruct = new VpcConstruct(scope, 'Vpc', {
    envName,
    logRetentionDays: envConfig.logRetentionDays,
  })

  const useCustomDomain = envConfig.useCustomDomain ?? true
  const dns = new DnsConstruct(scope, 'Dns', {
    domain: envConfig.domain,
    envName,
    useCustomDomain,
  })

  return { vpc: vpcConstruct.vpc, dns }
}
