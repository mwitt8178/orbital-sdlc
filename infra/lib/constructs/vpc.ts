import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as logs from 'aws-cdk-lib/aws-logs'
import * as iam from 'aws-cdk-lib/aws-iam'
import { Construct } from 'constructs'

export interface VpcConstructProps {
  /**
   * Environment name — used to determine NAT gateway count.
   * prod uses 2 NAT gateways for HA; non-prod uses 1 to reduce cost.
   */
  readonly envName: string
  /**
   * CloudWatch log retention in days for VPC Flow Logs.
   */
  readonly logRetentionDays: number
}

/**
 * VpcConstruct provisions the VPC that all OrbitalHub resources sit in.
 *
 * Subnets:
 *  - PUBLIC  — one per AZ; hosts NAT GW and future ALB
 *  - PRIVATE (with egress) — one per AZ; hosts Lambda functions
 *  - ISOLATED — one per AZ; hosts Aurora cluster (no internet access)
 *
 * NAT gateways:
 *  - prod: 2 (one per AZ for HA)
 *  - non-prod: 1 (cost saving — single point of failure acceptable in dev)
 *
 * VPC Endpoints (Gateway type — free):
 *  - S3
 *
 * VPC Endpoints (Interface type — paid but reduced NAT costs):
 *  - Secrets Manager
 *  - KMS
 *
 * Flow Logs: sent to CloudWatch Logs for security + debugging.
 */
export class VpcConstruct extends Construct {
  readonly vpc: ec2.Vpc

  constructor(scope: Construct, id: string, props: VpcConstructProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'
    const natGateways = isProd ? 2 : 1

    // Flow logs log group
    const flowLogGroup = new logs.LogGroup(this, 'FlowLogs', {
      logGroupName: `/orbital/${props.envName}/vpc/flow-logs`,
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    })

    // IAM role for VPC Flow Logs to write to CloudWatch
    const flowLogsRole = new iam.Role(this, 'FlowLogsRole', {
      assumedBy: new iam.ServicePrincipal('vpc-flow-logs.amazonaws.com'),
      description: `Orbital ${props.envName} — VPC flow logs CloudWatch writer`,
    })

    flowLogGroup.grantWrite(flowLogsRole)

    this.vpc = new ec2.Vpc(this, 'Vpc', {
      vpcName: `orbital-${props.envName}`,
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'isolated',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        },
      ],
      flowLogs: {
        cloudwatch: {
          destination: ec2.FlowLogDestination.toCloudWatchLogs(
            flowLogGroup,
            flowLogsRole,
          ),
          trafficType: ec2.FlowLogTrafficType.ALL,
        },
      },
    })

    // Gateway endpoint for S3 — free, avoids NAT charges for S3 traffic
    this.vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    })

    // Interface endpoint for Secrets Manager — Lambda can read secrets without NAT
    this.vpc.addInterfaceEndpoint('SecretsManagerEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      privateDnsEnabled: true,
    })

    // Interface endpoint for KMS — Lambda can use KMS without NAT
    this.vpc.addInterfaceEndpoint('KmsEndpoint', {
      service: ec2.InterfaceVpcEndpointAwsService.KMS,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      privateDnsEnabled: true,
    })

    // Outputs
    new cdk.CfnOutput(this, 'VpcId', {
      value: this.vpc.vpcId,
      description: `Orbital ${props.envName} VPC ID`,
      exportName: `OrbitalHub-${props.envName}-VpcId`,
    })

    new cdk.CfnOutput(this, 'VpcCidr', {
      value: this.vpc.vpcCidrBlock,
      description: `Orbital ${props.envName} VPC CIDR`,
    })
  }
}
