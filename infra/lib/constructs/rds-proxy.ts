// [Engineer-Sr · Sonnet · run-round8-02-aurora]
import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as iam from 'aws-cdk-lib/aws-iam'
import { Construct } from 'constructs'

export interface RdsProxyConstructProps {
  /**
   * Environment name - used in naming and removal policy.
   */
  readonly envName: string
  /**
   * VPC containing the Aurora cluster and Lambda functions.
   */
  readonly vpc: ec2.IVpc
  /**
   * Aurora cluster to front with the proxy.
   */
  readonly cluster: rds.DatabaseCluster
  /**
   * Secrets Manager secret holding Aurora master credentials.
   * RDS Proxy reads this to authenticate to Aurora.
   */
  readonly masterSecret: rds.DatabaseSecret
  /**
   * Existing security group to use as the proxy SG.
   *
   * The OrbitalHubStack creates this SG first (before Aurora) so Aurora's
   * SG ingress rule can reference it. This construct adds the Lambda → Proxy
   * ingress rule to the existing SG rather than creating a duplicate.
   *
   * If not provided, a new proxy SG is created (standalone usage without
   * the circular-dependency workaround).
   */
  readonly existingProxySg?: ec2.SecurityGroup
}

/**
 * RdsProxyConstruct - RDS Proxy in front of the Aurora Postgres cluster.
 *
 * The proxy is mandatory for Lambda → Aurora connections because Lambda
 * cannot maintain long-lived DB connections; the proxy pools them.
 *
 * Features:
 *  - Engine: Postgres (proxies Aurora Postgres 16)
 *  - IAM authentication: Lambda presents a signed token instead of a password
 *  - Idle client timeout: 30 minutes
 *  - Max connections: 95% of Aurora's max_connections
 *  - Security group: ingress from Lambda SG only
 *    (placeholder Lambda SG created here; 8-03 imports it by name)
 *  - Proxy SG is exposed as `proxySecurityGroup` so AuroraConstruct
 *    can restrict its own ingress to this SG only
 *  - Private subnet placement (PRIVATE_WITH_EGRESS - Lambda lives there)
 *
 * IAM auth flow:
 *  1. Lambda calls `rds-signer` to generate a short-lived signed token
 *  2. Lambda passes the token as the Postgres password
 *  3. RDS Proxy validates the token against IAM; proxies the connection to Aurora
 *  4. Aurora validates via IAM DB auth (iamAuthentication: true on the cluster)
 *
 * Circular dependency resolution:
 *  AuroraConstruct needs the proxy SG to configure its own SG ingress.
 *  RdsProxyConstruct needs the Aurora cluster to create the proxy.
 *  Solution: OrbitalHubStack creates the proxy SG independently first, passes
 *  it to both constructs via `existingProxySg`. This keeps each construct
 *  independently testable while avoiding the CDK circular dependency.
 */
export class RdsProxyConstruct extends Construct {
  /**
   * The RDS Proxy resource.
   * Consumers (Lambda constructs in 8-03) call `grantConnect` to give IAM
   * principals the `rds-db:connect` permission.
   */
  readonly proxy: rds.DatabaseProxy

  /**
   * Security group attached to the RDS Proxy.
   * Either the provided `existingProxySg` or a newly created one.
   * AuroraConstruct's SG allows inbound Postgres from this SG.
   */
  readonly proxySecurityGroup: ec2.SecurityGroup

  /**
   * Placeholder Lambda security group.
   * 8-03 imports this SG by ID and attaches it to the Lambda functions.
   * Named `orbital-{env}-lambda` so 8-03 can look it up by name.
   */
  readonly lambdaSecurityGroup: ec2.SecurityGroup

  constructor(scope: Construct, id: string, props: RdsProxyConstructProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'

    // ------------------------------------------------------------------
    // Placeholder Lambda security group
    // 8-03 will import this SG and attach it to Lambda functions.
    // We create it here so the proxy SG allows ingress from Lambda before
    // 8-03 lands.
    // ------------------------------------------------------------------
    this.lambdaSecurityGroup = new ec2.SecurityGroup(this, 'LambdaSg', {
      vpc: props.vpc,
      securityGroupName: `orbital-${props.envName}-lambda`,
      description: [
        `Orbital ${props.envName} - placeholder Lambda SG.`,
        '8-03 (Lambda) will attach this SG to Lambda functions.',
        'This SG is granted ingress to the RDS Proxy.',
      ].join(' '),
      allowAllOutbound: true, // Lambda needs egress for Secrets Manager, STS, etc.
    })

    // ------------------------------------------------------------------
    // RDS Proxy security group
    // Use the pre-created SG if provided (circular-dependency workaround),
    // otherwise create a new one (standalone / test usage).
    // ------------------------------------------------------------------
    if (props.existingProxySg) {
      this.proxySecurityGroup = props.existingProxySg
    } else {
      this.proxySecurityGroup = new ec2.SecurityGroup(this, 'ProxySg', {
        vpc: props.vpc,
        securityGroupName: `orbital-${props.envName}-rds-proxy`,
        description: `Orbital ${props.envName} - RDS Proxy SG. Accepts connections from Lambda SG only.`,
        allowAllOutbound: false,
      })
    }

    // Add inbound Postgres from Lambda SG to the proxy SG
    this.proxySecurityGroup.addIngressRule(
      this.lambdaSecurityGroup,
      ec2.Port.tcp(5432),
      'Lambda to RDS Proxy Postgres',
    )

    // ------------------------------------------------------------------
    // IAM role for RDS Proxy to read the master secret from Secrets Manager
    // ------------------------------------------------------------------
    const proxyRole = new iam.Role(this, 'ProxyRole', {
      assumedBy: new iam.ServicePrincipal('rds.amazonaws.com'),
      description: `Orbital ${props.envName} RDS Proxy - Secrets Manager reader`,
    })

    props.masterSecret.grantRead(proxyRole)

    // ------------------------------------------------------------------
    // RDS Proxy
    // ------------------------------------------------------------------
    this.proxy = new rds.DatabaseProxy(this, 'Proxy', {
      proxyTarget: rds.ProxyTarget.fromCluster(props.cluster),
      secrets: [props.masterSecret],
      vpc: props.vpc,
      vpcSubnets: {
        // Proxy sits in private-with-egress subnets alongside Lambda
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      },
      securityGroups: [this.proxySecurityGroup],

      // IAM authentication - Lambda presents signed tokens, no stored passwords
      iamAuth: true,

      // Idle client timeout: 30 minutes (1800 seconds)
      idleClientTimeout: cdk.Duration.minutes(30),

      // Connection borrowing: 95% of Aurora max_connections
      // Aurora Postgres 16 Serverless v2: max_connections auto-scales with ACU.
      // The proxy honours whatever Aurora reports via the secret.
      maxConnectionsPercent: 95,

      // Proxy name - unique per env
      dbProxyName: `orbital-${props.envName}-proxy`,

      // Debug logging - disabled in prod (can expose query parameters)
      debugLogging: !isProd,
    })

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ProxyEndpoint', {
      value: this.proxy.endpoint,
      description: `Orbital ${props.envName} RDS Proxy endpoint (read/write)`,
      exportName: `OrbitalHub-${props.envName}-RdsProxyEndpoint`,
    })

    new cdk.CfnOutput(this, 'LambdaSecurityGroupId', {
      value: this.lambdaSecurityGroup.securityGroupId,
      description: `Orbital ${props.envName} placeholder Lambda SG ID - imported by 8-03`,
      exportName: `OrbitalHub-${props.envName}-LambdaSgId`,
    })

    new cdk.CfnOutput(this, 'ProxySecurityGroupId', {
      value: this.proxySecurityGroup.securityGroupId,
      description: `Orbital ${props.envName} RDS Proxy SG ID`,
      exportName: `OrbitalHub-${props.envName}-ProxySgId`,
    })

    // Tag for cost allocation
    cdk.Tags.of(this).add('orbital:component', 'rds-proxy')
  }
}
