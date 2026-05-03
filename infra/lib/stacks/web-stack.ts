/**
 * web-stack.ts — CloudFront distribution, S3 UI bucket, WAF WebACL, Route 53 records.
 *
 * Phase 4 stack split: resources are instantiated directly on the parent scope
 * so logical IDs stay identical to the monolith.
 */
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { StaticUiConstruct } from '../constructs/static-ui'
import { WafConstruct } from '../constructs/waf'
import { DnsConstruct } from '../constructs/dns'
import { ApiGwHttpConstruct } from '../constructs/api-gw-http'
import { ApiGwWsConstruct } from '../constructs/api-gw-ws'
import { ObservabilityConstruct } from '../constructs/observability'
import { EnvConfig } from '../orbital-hub-stack'

export interface WebOutputs {
  readonly staticUi: StaticUiConstruct
  readonly waf: WafConstruct
}

/**
 * Provision web resources (CloudFront + S3 UI bucket + WAF) directly on the
 * given scope.
 */
export function buildWebResources(
  scope: Construct,
  envName: string,
  envConfig: EnvConfig,
  dns: DnsConstruct,
  apiGw: ApiGwHttpConstruct,
  wsApi: ApiGwWsConstruct,
  observability: ObservabilityConstruct,
): WebOutputs {
  const staticUi = new StaticUiConstruct(scope, 'StaticUi', {
    envName,
    domain: envConfig.domain,
    certificate: dns.certificate,
    hostedZone: dns.hostedZone,
  })

  // HTTP API stage ARN for WAF association
  const httpApiStageArn = cdk.Stack.of(scope).formatArn({
    service: 'apigateway',
    account: '',
    resource: `/apis/${apiGw.api.apiId}/stages/$default`,
  })

  // WS API stage ARN for WAF association
  const wsApiStageArn = cdk.Stack.of(scope).formatArn({
    service: 'apigateway',
    account: '',
    resource: `/apis/${wsApi.apiId}/stages/${wsApi.stageName}`,
  })

  const waf = new WafConstruct(scope, 'Waf', {
    envName,
    httpApiArn: httpApiStageArn,
    wsApiArn: wsApiStageArn,
    logRetentionDays: envConfig.logRetentionDays,
    alarmTopicArn: observability.alarmTopic.topicArn,
  })

  // Stack-level outputs for CloudFront + S3 (preserved from monolith)
  new cdk.CfnOutput(scope, 'UiBucketName', {
    value: staticUi.bucket.bucketName,
    description: `Orbital ${envName} UI S3 bucket name`,
    exportName: `OrbitalHub-${envName}-UiBucketNameStack`,
  })

  new cdk.CfnOutput(scope, 'CloudFrontDomain', {
    value: staticUi.distribution.distributionDomainName,
    description: `Orbital ${envName} CloudFront distribution domain (*.cloudfront.net)`,
    exportName: `OrbitalHub-${envName}-CloudFrontDomain`,
  })

  return { staticUi, waf }
}
