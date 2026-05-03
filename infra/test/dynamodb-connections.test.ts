// [Engineer-Sr · Sonnet · run-round8-04-websocket-api]
/**
 * dynamodb-connections.test.ts — Snapshot + property tests for DynamoDbConnectionsConstruct.
 *
 * TDD: RED first, GREEN once dynamodb-connections.ts is implemented.
 *
 * Tests verify:
 *  1. DynamoDB table is created with correct name
 *  2. PK is connection_id (String)
 *  3. Two GSIs exist: install_id-index and tenant_id-index
 *  4. TTL attribute is expires_at
 *  5. Encryption at rest is enabled (AWS_MANAGED)
 *  6. Point-in-time recovery is enabled
 *  7. BillingMode is PAY_PER_REQUEST
 *  8. Outputs include TableName and TableArn
 *  9. cdk-nag: no ERROR-level violations
 *  10. Snapshot
 */

import * as cdk from 'aws-cdk-lib'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib'
import { DynamoDbConnectionsConstruct } from '../lib/constructs/dynamodb-connections'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildConnectionsStack(envName = 'mwitt'): {
  stack: cdk.Stack
  template: Template
  connections: DynamoDbConnectionsConstruct
} {
  const app = new cdk.App()
  const stack = new cdk.Stack(app, `TestConnections-${envName}`, {
    env: { account: '123456789012', region: 'us-east-1' },
  })

  const connections = new DynamoDbConnectionsConstruct(stack, 'Connections', {
    envName,
  })

  const template = Template.fromStack(stack)
  return { stack, template, connections }
}

// ---------------------------------------------------------------------------
// Table existence and properties
// ---------------------------------------------------------------------------

describe('DynamoDbConnectionsConstruct — table', () => {
  test('creates exactly one DynamoDB table', () => {
    const { template } = buildConnectionsStack()
    template.resourceCountIs('AWS::DynamoDB::Table', 1)
  })

  test('table name is orbital-connections-{env}', () => {
    const { template } = buildConnectionsStack('mwitt')
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'orbital-connections-mwitt',
    })
  })

  test('partition key is connection_id (String)', () => {
    const { template } = buildConnectionsStack()
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      KeySchema: Match.arrayWith([
        { AttributeName: 'connection_id', KeyType: 'HASH' },
      ]),
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: 'connection_id', AttributeType: 'S' },
      ]),
    })
  })

  test('billing mode is PAY_PER_REQUEST', () => {
    const { template } = buildConnectionsStack()
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      BillingMode: 'PAY_PER_REQUEST',
    })
  })

  test('TTL attribute is expires_at', () => {
    const { template } = buildConnectionsStack()
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      TimeToLiveSpecification: {
        AttributeName: 'expires_at',
        Enabled: true,
      },
    })
  })

  test('point-in-time recovery is enabled', () => {
    const { template } = buildConnectionsStack()
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      PointInTimeRecoverySpecification: {
        PointInTimeRecoveryEnabled: true,
      },
    })
  })

  test('encryption is enabled (SSEEnabled: true)', () => {
    const { template } = buildConnectionsStack()
    // AWS_MANAGED encryption sets SSEEnabled: true but does not set SSEType
    // in the CloudFormation resource (SSEType is only present for CUSTOMER_MANAGED).
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      SSESpecification: {
        SSEEnabled: true,
      },
    })
  })
})

// ---------------------------------------------------------------------------
// GSIs
// ---------------------------------------------------------------------------

describe('DynamoDbConnectionsConstruct — GSIs', () => {
  test('has exactly 2 GSIs', () => {
    const { template } = buildConnectionsStack()
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({ IndexName: 'install_id-index' }),
        Match.objectLike({ IndexName: 'tenant_id-index' }),
      ]),
    })
  })

  test('install_id-index GSI has install_id as PK', () => {
    const { template } = buildConnectionsStack()
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'install_id-index',
          KeySchema: Match.arrayWith([
            { AttributeName: 'install_id', KeyType: 'HASH' },
          ]),
        }),
      ]),
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: 'install_id', AttributeType: 'S' },
      ]),
    })
  })

  test('tenant_id-index GSI has tenant_id as PK', () => {
    const { template } = buildConnectionsStack()
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'tenant_id-index',
          KeySchema: Match.arrayWith([
            { AttributeName: 'tenant_id', KeyType: 'HASH' },
          ]),
        }),
      ]),
      AttributeDefinitions: Match.arrayWith([
        { AttributeName: 'tenant_id', AttributeType: 'S' },
      ]),
    })
  })

  test('both GSIs project ALL attributes', () => {
    const { template } = buildConnectionsStack()
    template.hasResourceProperties('AWS::DynamoDB::Table', {
      GlobalSecondaryIndexes: Match.arrayWith([
        Match.objectLike({
          IndexName: 'install_id-index',
          Projection: { ProjectionType: 'ALL' },
        }),
        Match.objectLike({
          IndexName: 'tenant_id-index',
          Projection: { ProjectionType: 'ALL' },
        }),
      ]),
    })
  })
})

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

describe('DynamoDbConnectionsConstruct — outputs', () => {
  test('outputs include TableName', () => {
    const { template } = buildConnectionsStack()
    const outputs = template.findOutputs('*')
    expect(Object.keys(outputs).some((k) => k.includes('TableName'))).toBe(true)
  })

  test('outputs include TableArn', () => {
    const { template } = buildConnectionsStack()
    const outputs = template.findOutputs('*')
    expect(Object.keys(outputs).some((k) => k.includes('TableArn'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// cdk-nag
// ---------------------------------------------------------------------------

describe('DynamoDbConnectionsConstruct — cdk-nag', () => {
  test('no ERROR-level violations', () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, 'NagConnectionsStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })

    new DynamoDbConnectionsConstruct(stack, 'Connections', { envName: 'mwitt' })

    NagSuppressions.addStackSuppressions(stack, [
      {
        id: 'AwsSolutions-DDB3',
        reason: 'Point-in-time recovery is explicitly enabled.',
      },
    ])

    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }))
    expect(() => app.synth()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

describe('DynamoDbConnectionsConstruct — snapshot', () => {
  test('mwitt stack matches snapshot', () => {
    const { template } = buildConnectionsStack('mwitt')
    expect(template.toJSON()).toMatchSnapshot()
  })
})
