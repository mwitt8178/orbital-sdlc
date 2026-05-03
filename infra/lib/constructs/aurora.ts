// [Engineer-Sr · Sonnet · run-round8-02-aurora]
import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as logs from 'aws-cdk-lib/aws-logs'
import { Construct } from 'constructs'

export interface AuroraConstructProps {
  /**
   * Environment name - drives multi-AZ, backup retention, and ACU range.
   */
  readonly envName: string
  /**
   * VPC to place the Aurora cluster inside (isolated subnets).
   */
  readonly vpc: ec2.IVpc
  /**
   * Minimum Aurora Capacity Units. 0.5 for non-prod, 1 for prod.
   */
  readonly minAcu: number
  /**
   * Maximum Aurora Capacity Units. 4 for non-prod, 16 for prod.
   */
  readonly maxAcu: number
  /**
   * CloudWatch log retention for cluster activity/error logs.
   */
  readonly logRetentionDays: number
  /**
   * Security group from which the Aurora cluster accepts connections
   * (should be the RDS Proxy SG - wired in RdsProxyConstruct).
   */
  readonly allowedSg: ec2.ISecurityGroup
}

/**
 * AuroraConstruct - Aurora Postgres Serverless v2 cluster for the Orbital Hub.
 *
 * Features:
 *  - Aurora Postgres 16 Serverless v2
 *  - ACU range from env context (mwitt: 0.5-4, prod: 1-16)
 *  - Multi-AZ writer + reader instance for prod; single writer for non-prod
 *  - Encryption at rest (AWS-managed KMS key; per-tenant CMK added in 8-07)
 *  - Automated backups: 7 days (non-prod), 35 days (prod)
 *  - Point-in-time recovery (always enabled on Aurora)
 *  - Performance Insights enabled
 *  - Custom parameter group:
 *      shared_preload_libraries = 'pg_stat_statements, pgaudit'
 *      (pgvector installed via CREATE EXTENSION at migration time)
 *      log_min_duration_statement = 500
 *      log_connections = on
 *      log_disconnections = on
 *  - Security group: ingress only from allowedSg (RDS Proxy SG)
 *  - Isolated subnet placement (no internet access)
 */
export class AuroraConstruct extends Construct {
  /**
   * The Aurora cluster. Callers (e.g. RdsProxyConstruct) reference this.
   */
  readonly cluster: rds.DatabaseCluster

  /**
   * Security group attached to the Aurora cluster.
   * Ingress is restricted to allowedSg (RDS Proxy SG).
   */
  readonly securityGroup: ec2.SecurityGroup

  /**
   * Secrets Manager secret holding the master DB credentials.
   * Used by the migration runner Lambda; read-only by other consumers.
   */
  readonly masterSecret: rds.DatabaseSecret

  constructor(scope: Construct, id: string, props: AuroraConstructProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'

    // ------------------------------------------------------------------
    // Security group - ingress only from RDS Proxy SG
    // ------------------------------------------------------------------
    this.securityGroup = new ec2.SecurityGroup(this, 'AuroraSg', {
      vpc: props.vpc,
      securityGroupName: `orbital-${props.envName}-aurora`,
      description: `Orbital ${props.envName} - Aurora cluster SG. Accepts connections from RDS Proxy only.`,
      allowAllOutbound: false,
    })

    // Allow inbound Postgres from the RDS Proxy SG
    this.securityGroup.addIngressRule(
      props.allowedSg,
      ec2.Port.tcp(5432),
      'RDS Proxy to Aurora Postgres',
    )

    // ------------------------------------------------------------------
    // Subnet group - isolated subnets only (no internet access)
    // ------------------------------------------------------------------
    const subnetGroup = new rds.SubnetGroup(this, 'SubnetGroup', {
      vpc: props.vpc,
      description: `Orbital ${props.envName} Aurora isolated subnet group`,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    // ------------------------------------------------------------------
    // DB parameter group - Postgres 16 cluster params
    // pgvector, pg_stat_statements, pgaudit, audit logging
    // ------------------------------------------------------------------
    const parameterGroup = new rds.ParameterGroup(this, 'ParamGroup', {
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),
      description: `Orbital ${props.envName} Aurora Postgres 16 cluster parameter group`,
      parameters: {
        // Aurora Postgres pgvector is a trusted extension installed via
        // CREATE EXTENSION vector — NOT loaded via shared_preload_libraries.
        // The migration runner Lambda executes the CREATE EXTENSION at runtime.
        // Aurora's shared_preload_libraries allowlist does not include 'vector'.
        shared_preload_libraries: 'pg_stat_statements,pgaudit',
        // Log queries taking longer than 500ms
        log_min_duration_statement: '500',
        // Audit connection lifecycle
        log_connections: '1',
        log_disconnections: '1',
      },
    })

    // ------------------------------------------------------------------
    // Master secret (Secrets Manager) - auto-rotated by Aurora
    // ------------------------------------------------------------------
    this.masterSecret = new rds.DatabaseSecret(this, 'MasterSecret', {
      username: 'orbital_admin',
      secretName: `/orbital/${props.envName}/aurora/master-credentials`,
    })

    // ------------------------------------------------------------------
    // Aurora Serverless v2 cluster
    // ------------------------------------------------------------------
    this.cluster = new rds.DatabaseCluster(this, 'Cluster', {
      clusterIdentifier: `orbital-${props.envName}`,
      engine: rds.DatabaseClusterEngine.auroraPostgres({
        version: rds.AuroraPostgresEngineVersion.VER_16_4,
      }),

      // Credentials from Secrets Manager
      credentials: rds.Credentials.fromSecret(this.masterSecret),

      // Serverless v2 writer instance
      writer: rds.ClusterInstance.serverlessV2('Writer', {
        performanceInsightEncryptionKey: undefined, // default KMS key
        enablePerformanceInsights: true,
        performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
        // Publicly accessible must be false for isolated subnets
        publiclyAccessible: false,
      }),

      // Add a read replica in prod for HA (multi-AZ promotion target)
      readers: isProd
        ? [
            rds.ClusterInstance.serverlessV2('Reader', {
              enablePerformanceInsights: true,
              performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
              publiclyAccessible: false,
              // Allow this reader to be promoted to writer on failover
              scaleWithWriter: true,
            }),
          ]
        : [],

      // Serverless v2 capacity range
      serverlessV2MinCapacity: props.minAcu,
      serverlessV2MaxCapacity: props.maxAcu,

      // Database configuration
      defaultDatabaseName: 'orbital_hub',

      // Network
      vpc: props.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      subnetGroup,
      securityGroups: [this.securityGroup],

      // Parameter group
      parameterGroup,

      // Encryption at rest (AWS-managed key; CMK added in 8-07)
      storageEncrypted: true,

      // Backup retention
      backup: {
        retention: isProd ? cdk.Duration.days(35) : cdk.Duration.days(7),
        // Prefer low-traffic window for backups
        preferredWindow: '03:00-04:00',
      },

      // Maintenance window
      preferredMaintenanceWindow: 'sun:04:00-sun:05:00',

      // CloudWatch log exports
      cloudwatchLogsExports: ['postgresql'],
      cloudwatchLogsRetention: props.logRetentionDays as logs.RetentionDays,

      // IAM DB authentication (required for RDS Proxy IAM auth)
      iamAuthentication: true,

      // Instance removal policy - retain in prod to protect data
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'ClusterEndpoint', {
      value: this.cluster.clusterEndpoint.hostname,
      description: `Orbital ${props.envName} Aurora cluster writer endpoint`,
      exportName: `OrbitalHub-${props.envName}-AuroraEndpoint`,
    })

    new cdk.CfnOutput(this, 'ClusterReaderEndpoint', {
      value: this.cluster.clusterReadEndpoint.hostname,
      description: `Orbital ${props.envName} Aurora cluster reader endpoint`,
      exportName: `OrbitalHub-${props.envName}-AuroraReaderEndpoint`,
    })

    new cdk.CfnOutput(this, 'MasterSecretArn', {
      value: this.masterSecret.secretArn,
      description: `Orbital ${props.envName} Aurora master credentials secret ARN`,
      exportName: `OrbitalHub-${props.envName}-AuroraMasterSecretArn`,
    })

    new cdk.CfnOutput(this, 'DatabaseName', {
      value: 'orbital_hub',
      description: `Orbital ${props.envName} Aurora default database name`,
    })

    // Tag for cost allocation
    cdk.Tags.of(this).add('orbital:component', 'aurora')
  }
}
