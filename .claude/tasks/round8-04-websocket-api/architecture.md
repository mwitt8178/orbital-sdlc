# Round 8-04 — WebSocket API + Connection State + Fanout

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: M

## Depends on
8-01 (CDK), 8-02 (Aurora — for tenant validation), 8-03 (HTTP API + Cognito + PKI authorizers — reuse the auth code)

## Why
Replace Round 7's in-process WS hub with API Gateway WebSocket. Connection state in DynamoDB. Fanout via SNS-triggered Lambda.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `infra/lib/constructs/api-gw-ws.ts` | NEW | WebSocket API construct |
| `infra/lib/constructs/dynamodb-connections.ts` | NEW | Connections table |
| `packages/orchestrator/src/lambda/ws/{connect.ts,disconnect.ts,default.ts,fanout.ts}` | NEW | WS Lambda handlers |
| `packages/orchestrator/src/ws/aws-fanout.ts` | NEW | Hub-side helper to push messages via API GW Mgmt API |
| `packages/orchestrator/src/events/store.ts` | extend | After `append`, publish to SNS topic (in 8-05 — coordinate) |

## API Gateway WebSocket
- Custom domain: `ws.${envConfig.domain}`
- Routes:
  - `$connect` → connect Lambda
  - `$disconnect` → disconnect Lambda
  - `$default` → default Lambda (handles `subscribe`/`unsubscribe`/`ping` actions)
- API GW Mgmt API ARN exposed for fanout Lambda to push messages

## Connection state (DynamoDB)
**Table: `orbital-connections-${env}`**
- PK: `connection_id` (string)
- Attributes: `install_id`, `tenant_id`, `auth_kind` ('cognito'|'pki'), `subscriptions` (set of strings), `connected_at`, `expires_at` (TTL)
- GSI: `install_id-index` for "all connections for this install"
- GSI: `tenant_id-index` for "all connections in this tenant"
- TTL on `expires_at` — cleans up stale connections automatically

## Connect handler
```typescript
export const handler = async (event: APIGatewayWebSocketEventV2) => {
  // Auth: same logic as 8-03's authorizers, adapted for WS
  // Headers come via query string for WS (no header support in API GW WS)
  // OR use a $connect Lambda authorizer (cleaner)
  const auth = await validateAuth(event)
  if (!auth) return { statusCode: 401 }

  await ddb.putItem({
    TableName: env.CONNECTIONS_TABLE,
    Item: {
      connection_id: { S: event.requestContext.connectionId },
      install_id: { S: auth.installId },
      tenant_id: { S: auth.tenantId },
      auth_kind: { S: auth.kind },
      subscriptions: { SS: ['init'] },  // empty set placeholder
      connected_at: { N: String(Date.now()) },
      expires_at: { N: String(Math.floor(Date.now()/1000) + 7200) },  // 2h TTL
    },
  })

  return { statusCode: 200 }
}
```

## Default handler (subscribe/unsubscribe)
Routes `{ action: "subscribe", topics: ["task:123", "channel:orb-eng"] }`:
1. Validate every topic against the connection's tenant_id (no cross-tenant subscribes)
2. Update `subscriptions` set in DynamoDB
3. Send confirmation back to client via Mgmt API

## Fanout Lambda
Subscribed to the SNS event topic (from 8-05).
On each message:
1. Determine which subscription patterns match the event:
   - `task:<id>` matches `subscribe:task:<id>` for that exact task
   - `channel:<name>` matches `subscribe:channel:<name>`
   - `worker:<install_id>:*` matches anything on that install
2. Query DynamoDB GSI `tenant_id-index` for connections in the event's tenant
3. Filter by `subscriptions` set membership
4. For each matching connection: invoke API GW Mgmt API `postToConnection`
5. On `GoneException` (client disconnected): delete the row
6. Batch via SQS for high-volume events; the immediate fanout Lambda handles real-time, the SQS-backed Lambda handles overflow

## Hub-side helper
`packages/orchestrator/src/ws/aws-fanout.ts` — when running in AWS Lambda mode, replaces the in-process WS broadcast with SNS publish. Round 7's `ws/hub.ts` becomes a thin abstraction with two implementations (in-process for self-host, SNS-backed for AWS).

## Auth handshake
For Cognito-authenticated browser clients: pass the JWT in the WS connect URL query string (`wss://ws.../?token=eyJ...`). Connect Lambda validates.

For PKI-authenticated installs: pass the signed envelope as query string params (`install_id`, `sig`, `sig_body`). Connect Lambda validates.

Both produce the same `connection_id` table row.

## Acceptance criteria
1. After deploy, `wscat -c wss://ws.mwitt.orbital.team.dev?token=<cognito-jwt>` connects successfully.
2. Send `{action:"subscribe",topics:["task:abc"]}` → DynamoDB row updated.
3. Publish event with `aggregate_id=task:abc` → fanout Lambda fires → message arrives at the WS client within 500ms.
4. Disconnect → DynamoDB row removed (or marked).
5. Cross-tenant subscribe attempt → rejected (subscribe to a topic for tenant B from tenant A's connection).
6. 1000 concurrent connections sustained without error (load test).
7. Fanout Lambda errors → DLQ catches; CloudWatch alarm fires.

## Hard-stop checks
```
grep -E "WebSocketApi" infra/lib/constructs/api-gw-ws.ts
grep -E "putItem.*connection_id" packages/orchestrator/src/lambda/ws/connect.ts
grep -E "postToConnection" packages/orchestrator/src/lambda/ws/fanout.ts
ls packages/orchestrator/src/ws/aws-fanout.ts
```

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round8-04-websocket-api]`
