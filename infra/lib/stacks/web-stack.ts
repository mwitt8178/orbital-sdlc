/**
 * web-stack.ts — WAF WebACL + Route 53 outputs.
 *
 * StaticUiConstruct is created in data-stack.ts (before ReplayBucketConstruct)
 * to preserve CDK singleton provider ordering. This file only provisions WAF
 * and emits the stack-level CloudFront/S3 outputs.
 *
 * Phase 4 stack split: resources are instantiated directly on the parent scope
 * so logical IDs stay identical to the monolith.
 */
import * as cdk from 'aws-cdk-lib'
import { Construct } from 'constructs'
import { StaticUiConstruct } from '../constructs/static-ui'
import { WafConstruct } from '../constructs/waf'
import { ApiGwHttpConstruct } from '../constructs/api-gw-http'
import { ApiGwWsConstruct } from '../constructs/api-gw-ws'
import { ObservabilityConstruct } from '../constructs/observability'
import { EnvConfig } from '../orbital-hub-stack'

export interface WebOutputs {
  readonly waf: WafConstruct
}

/**
 * Provision WAF and emit CloudFront + S3 stack outputs directly on the given scope.
 * StaticUiConstruct (and its S3 bucket) is received as a parameter — it must
 * already exist (created in data-stack.ts) to preserve logical ID ordering.
 */
export function buildWebResources(
  scope: Construct,
  envName: string,
  envConfig: EnvConfig,
  staticUi: StaticUiConstruct,
  apiGw: ApiGwHttpConstruct,
  wsApi: ApiGwWsConstruct,
  observability: ObservabilityConstruct,
): WebOutputs {
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

  // Stack-level outputs (preserved from monolith)
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

  return { waf }
}
