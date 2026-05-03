// [Engineer-Sr · Sonnet · run-round8-04-websocket-api]
import * as cdk from 'aws-cdk-lib'
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb'
import { Construct } from 'constructs'

export interface DynamoDbConnectionsProps {
  /**
   * Environment name (mwitt | rreed | prod) - used in table name and tags.
   */
  readonly envName: string
}

/**
 * DynamoDbConnectionsConstruct - `orbital-connections-${env}` table.
 *
 * Schema (per architecture.md):
 *   PK: connection_id (String)
 *   Attributes: install_id, tenant_id, auth_kind, subscriptions, connected_at, expires_at
 *
 * GSIs:
 *   install_id-index  - PK: install_id (for "all connections for this install")
 *   tenant_id-index   - PK: tenant_id  (for fanout: "all connections in this tenant")
 *
 * TTL: expires_at (Number - Unix epoch seconds). Set to connection_time + 2h.
 * Encryption: AWS_OWNED_KMS (no external key needed; sufficient for connection metadata).
 * BillingMode: PAY_PER_REQUEST (WebSocket connections are spiky by nature).
 */
export class DynamoDbConnectionsConstruct extends Construct {
  /**
   * The DynamoDB table resource.
   * Fanout Lambda and connect/disconnect handlers receive IAM grants on this table.
   */
  readonly table: dynamodb.Table

  constructor(scope: Construct, id: string, props: DynamoDbConnectionsProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'

    // ------------------------------------------------------------------
    // Main table
    // ------------------------------------------------------------------
    this.table = new dynamodb.Table(this, 'Table', {
      tableName: `orbital-connections-${props.envName}`,
      partitionKey: {
        name: 'connection_id',
        type: dynamodb.AttributeType.STRING,
      },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      // TTL on expires_at (Unix epoch seconds)
      timeToLiveAttribute: 'expires_at',
      // Encryption at rest - AWS owned key is sufficient for ephemeral
      // connection metadata. Per-tenant CMKs are used for replay blobs (8-07).
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      // Point-in-time recovery enabled - allows up to 35-day restore.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      // Retain table in prod; destroy in dev/staging for clean teardown.
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
      stream: dynamodb.StreamViewType.NEW_AND_OLD_IMAGES,
    })

    // ------------------------------------------------------------------
    // GSI: install_id-index
    // Purpose: "give me all WS connections for install X"
    // ------------------------------------------------------------------
    this.table.addGlobalSecondaryIndex({
      indexName: 'install_id-index',
      partitionKey: {
        name: 'install_id',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    })

    // ------------------------------------------------------------------
    // GSI: tenant_id-index
    // Purpose: fanout - "give me all WS connections in tenant Y"
    // ------------------------------------------------------------------
    this.table.addGlobalSecondaryIndex({
      indexName: 'tenant_id-index',
      partitionKey: {
        name: 'tenant_id',
        type: dynamodb.AttributeType.STRING,
      },
      projectionType: dynamodb.ProjectionType.ALL,
    })

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'TableName', {
      value: this.table.tableName,
      description: `Orbital ${props.envName} WebSocket connections DynamoDB table`,
      exportName: `OrbitalHub-${props.envName}-ConnectionsTableName`,
    })

    new cdk.CfnOutput(this, 'TableArn', {
      value: this.table.tableArn,
      description: `Orbital ${props.envName} WebSocket connections DynamoDB table ARN`,
      exportName: `OrbitalHub-${props.envName}-ConnectionsTableArn`,
    })

    cdk.Tags.of(this).add('orbital:component', 'dynamodb-connections')
  }
}
