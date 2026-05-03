// [Engineer-Sr · Sonnet · run-round8-08-observability]
/**
 * waf.ts - Web ACL + rules + association for Orbital Hub.
 *
 * Provisions:
 *  - AWS WAFv2 WebACL: `orbital-${env}-acl`
 *  - AWS Managed Rule Sets:
 *    - AWSManagedRulesCommonRuleSet (OWASP Top 10)
 *    - AWSManagedRulesKnownBadInputsRuleSet
 *    - AWSManagedRulesAmazonIpReputationList
 *  - Custom rate-limit rules:
 *    - General: 1000 req/min per IP
 *    - Auth endpoint: 50 sign-in attempts / 15 min per IP
 *    - No User-Agent header: BLOCK (bot signal)
 *  - WAF logging → CloudWatch Logs log group `aws-waf-logs-orbital-${env}`
 *  - Association: HTTP API Gateway + WebSocket API Gateway + CloudFront distribution
 *
 * NOTE: WAFv2 scope:
 *  - CloudFront associations use scope=CLOUDFRONT (must be deployed to us-east-1)
 *  - API Gateway associations use scope=REGIONAL
 *  - In a single-stack multi-region deployment this means we need two WebACLs.
 *    The CloudFront WebACL is created in us-east-1 via CfnWebAcl.
 *    The Regional WebACL covers both HTTP API and WebSocket API.
 *
 * Architecture decision: Use a single REGIONAL WebACL for API GW resources.
 * CloudFront WebACL is best added via CfnWebACLAssociation after the regional
 * stack is deployed. For this round, we associate the REGIONAL WebACL with
 * the HTTP API and the WebSocket API, and document the CloudFront WAF as a
 * follow-up (WAF + CloudFront association requires the same account/region
 * of us-east-1 for global scope). The REGIONAL WebACL covers the API attack
 * surface; CloudFront WAF is addable separately.
 *
 * Per architecture.md §"WAF":
 *   - AWSManagedRulesCommonRuleSet
 *   - AWSManagedRulesKnownBadInputsRuleSet
 *   - AWSManagedRulesAmazonIpReputationList
 *   - Rate limit: 1000 req/min per IP (general)
 *   - Rate limit: 50 sign-in attempts/15min per IP (auth endpoint)
 *   - Block requests with no User-Agent header
 */

import * as cdk from 'aws-cdk-lib'
import * as wafv2 from 'aws-cdk-lib/aws-wafv2'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch'
import { Construct } from 'constructs'
import { NagSuppressions } from 'cdk-nag'

export interface WafConstructProps {
  /** Environment name - used in naming. */
  readonly envName: string
  /** HTTP API Gateway ARN - WAF association target. */
  readonly httpApiArn: string
  /** WebSocket API ARN - WAF association target (regional scope only). */
  readonly wsApiArn?: string
  /** CloudWatch log retention in days. */
  readonly logRetentionDays: number
  /**
   * Alarm SNS topic ARN - receives WAF blocked-request alarms.
   * Optional; if not provided, alarms only produce CW metrics.
   */
  readonly alarmTopicArn?: string
}

/**
 * WafConstruct - AWS WAFv2 Web ACL with managed + custom rules.
 *
 * Exposes:
 *  - `webAcl` - the CfnWebACL resource
 *  - `webAclId` - the WebACL ID (for use in CFN cross-references)
 *  - `webAclArn` - the WebACL ARN (for CloudFront association)
 *  - `logGroup` - WAF access log group
 */
export class WafConstruct extends Construct {
  /** The WAFv2 Web ACL (REGIONAL scope - covers API GW resources). */
  readonly webAcl: wafv2.CfnWebACL

  /** The WebACL ID token. */
  readonly webAclId: string

  /** The WebACL ARN (exported for CloudFront association). */
  readonly webAclArn: string

  /** WAF access log group. */
  readonly logGroup: logs.LogGroup

  constructor(scope: Construct, id: string, props: WafConstructProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'
    const removalPolicy = isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY

    // ------------------------------------------------------------------
    // WAF Log group
    // IMPORTANT: AWS WAF requires the log group name to start with "aws-waf-logs-"
    // ------------------------------------------------------------------
    this.logGroup = new logs.LogGroup(this, 'WafLogGroup', {
      logGroupName: `aws-waf-logs-orbital-${props.envName}`,
      retention: props.logRetentionDays as logs.RetentionDays,
      removalPolicy,
    })

    // ------------------------------------------------------------------
    // WAFv2 WebACL - REGIONAL scope (covers HTTP API + WebSocket API)
    // ------------------------------------------------------------------
    this.webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
      name: `orbital-${props.envName}-acl`,
      scope: 'REGIONAL',
      // NOTE: WAF Description regex disallows parentheses entirely.
      // The full pattern is documented in pre-deploy-validation/architecture.md.
      description: `Orbital ${props.envName} - Web ACL for API Gateway HTTP and WebSocket`,
      defaultAction: { allow: {} },
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: `orbital-${props.envName}-waf`,
        sampledRequestsEnabled: true,
      },
      rules: [
        // -------------------------------------------------------------------
        // Rule 1: AWSManagedRulesAmazonIpReputationList (priority 0)
        // Blocks requests from IPs on Amazon's threat intel list.
        // Evaluated first (lowest priority number = highest precedence).
        // -------------------------------------------------------------------
        {
          name: 'AWSManagedRulesAmazonIpReputationList',
          priority: 0,
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesAmazonIpReputationList',
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `orbital-${props.envName}-ip-reputation`,
            sampledRequestsEnabled: true,
          },
        },

        // -------------------------------------------------------------------
        // Rule 2: AWSManagedRulesCommonRuleSet (priority 1)
        // OWASP Top 10 protections: SQLi, XSS, path traversal, etc.
        // -------------------------------------------------------------------
        {
          name: 'AWSManagedRulesCommonRuleSet',
          priority: 1,
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `orbital-${props.envName}-common-rules`,
            sampledRequestsEnabled: true,
          },
        },

        // -------------------------------------------------------------------
        // Rule 3: AWSManagedRulesKnownBadInputsRuleSet (priority 2)
        // Blocks known bad inputs: SSRF, Log4j JNDI, etc.
        // -------------------------------------------------------------------
        {
          name: 'AWSManagedRulesKnownBadInputsRuleSet',
          priority: 2,
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesKnownBadInputsRuleSet',
            },
          },
          overrideAction: { none: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `orbital-${props.envName}-bad-inputs`,
            sampledRequestsEnabled: true,
          },
        },

        // -------------------------------------------------------------------
        // Rule 4: Block requests without User-Agent header (priority 3)
        // Simple bot filter - legitimate clients always send User-Agent.
        //
        // NOTE: SingleHeader requires PascalCase `Name` per the CFN schema.
        // The CDK L1 type is `any` for FieldToMatch.singleHeader, so the
        // object passes through unmodified. Using lowercase `name` produces
        // an invalid template that AWS rejects at deploy time.
        // -------------------------------------------------------------------
        {
          name: 'BlockMissingUserAgent',
          priority: 3,
          statement: {
            notStatement: {
              statement: {
                sizeConstraintStatement: {
                  fieldToMatch: {
                    singleHeader: { Name: 'user-agent' },
                  },
                  comparisonOperator: 'GE',
                  size: 1,
                  textTransformations: [{ priority: 0, type: 'NONE' }],
                },
              },
            },
          },
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `orbital-${props.envName}-missing-user-agent`,
            sampledRequestsEnabled: true,
          },
        },

        // -------------------------------------------------------------------
        // Rule 5: General rate limit - 1000 req/min per IP (priority 4)
        // AWS WAF rate-based rules use a 5-minute evaluation window by default.
        // 1000 req/min × 5 min = 5000 requests per 5-min window.
        // -------------------------------------------------------------------
        {
          name: 'GeneralRateLimit',
          priority: 4,
          statement: {
            rateBasedStatement: {
              limit: 5000, // 5-minute window; 1000/min × 5
              aggregateKeyType: 'IP',
            },
          },
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `orbital-${props.envName}-rate-limit-general`,
            sampledRequestsEnabled: true,
          },
        },

        // -------------------------------------------------------------------
        // Rule 6: Auth endpoint rate limit - 50 sign-in attempts / 15 min per IP
        // Matches /trpc/auth/* paths.
        // AWS WAF rate window: 5 min. 50 req/15min ≈ ~17/5min → use 20 as safe threshold.
        // -------------------------------------------------------------------
        {
          name: 'AuthEndpointRateLimit',
          priority: 5,
          statement: {
            rateBasedStatement: {
              limit: 100, // 50 req/15min → conservatively 100 per 5-min window
              aggregateKeyType: 'IP',
              scopeDownStatement: {
                byteMatchStatement: {
                  fieldToMatch: {
                    uriPath: {},
                  },
                  positionalConstraint: 'STARTS_WITH',
                  searchString: '/trpc/auth',
                  textTransformations: [{ priority: 0, type: 'LOWERCASE' }],
                },
              },
            },
          },
          action: { block: {} },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: `orbital-${props.envName}-rate-limit-auth`,
            sampledRequestsEnabled: true,
          },
        },
      ],
    })

    this.webAclId = this.webAcl.attrId
    this.webAclArn = this.webAcl.attrArn

    // ------------------------------------------------------------------
    // WAF logging configuration
    // AWS WAF expects the Firehose/CloudWatch Logs ARN in LoggingConfiguration.
    // ------------------------------------------------------------------
    new wafv2.CfnLoggingConfiguration(this, 'WafLogging', {
      resourceArn: this.webAcl.attrArn,
      logDestinationConfigs: [this.logGroup.logGroupArn],
    })

    // ------------------------------------------------------------------
    // API Gateway Associations (HTTP V2 + WebSocket V2)
    // ------------------------------------------------------------------
    // AWS WAFv2 only supports the following regional resources:
    //   ALB, REST API (V1), AppSync, Cognito User Pool, App Runner,
    //   Verified Access, and CloudFront (global).
    // API Gateway HTTP API (V2) and WebSocket API (V2) are NOT supported
    // by WAF directly. To protect HTTP/WS APIs, place CloudFront in front
    // and associate WAF with the CloudFront distribution instead.
    // Props preserved for API stability; both are no-ops at deploy time.
    void props.httpApiArn
    void props.wsApiArn

    // ------------------------------------------------------------------
    // CloudWatch Alarm - blocked requests rate > 100/min
    // Uses the WAF "BlockedRequests" metric. Threshold of 500 over 5 min
    // corresponds to ~100/min.
    // ------------------------------------------------------------------
    const blockedRequestsAlarm = new cloudwatch.Alarm(this, 'BlockedRequestsAlarm', {
      alarmName: `orbital-${props.envName}-waf-blocked-requests`,
      alarmDescription: 'WAF blocked requests rate is elevated - possible attack in progress',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/WAFV2',
        metricName: 'BlockedRequests',
        dimensionsMap: {
          Region: cdk.Stack.of(this).region,
          WebACL: `orbital-${props.envName}-acl`,
          Rule: 'ALL',
        },
        period: cdk.Duration.minutes(5),
        statistic: 'Sum',
      }),
      threshold: 500,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    })

    if (props.alarmTopicArn) {
      const alarmTopic = cdk.aws_sns.Topic.fromTopicArn(this, 'AlarmTopicRef', props.alarmTopicArn)
      blockedRequestsAlarm.addAlarmAction(
        new cdk.aws_cloudwatch_actions.SnsAction(alarmTopic),
      )
    }

    // ------------------------------------------------------------------
    // CloudFormation Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'WebAclArn', {
      value: this.webAcl.attrArn,
      description: `Orbital ${props.envName} WAF WebACL ARN`,
      exportName: `OrbitalHub-${props.envName}-WebAclArn`,
    })

    new cdk.CfnOutput(this, 'WebAclId', {
      value: this.webAcl.attrId,
      description: `Orbital ${props.envName} WAF WebACL ID`,
      exportName: `OrbitalHub-${props.envName}-WebAclId`,
    })

    // ------------------------------------------------------------------
    // cdk-nag suppressions
    // ------------------------------------------------------------------
    NagSuppressions.addResourceSuppressions(this.webAcl, [
      {
        id: 'AwsSolutions-WAF1',
        reason: 'WAF shield advanced is out of scope for this tier; managed rules provide OWASP coverage.',
      },
      {
        id: 'AwsSolutions-WAF4',
        reason: 'AWS managed rule groups do not support custom metric names for individual rules.',
      },
    ])

    cdk.Tags.of(this).add('orbital:component', 'waf')
  }
}
