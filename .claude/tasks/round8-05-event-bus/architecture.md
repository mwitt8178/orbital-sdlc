# Round 8-05 — Event Bus (SNS + SQS + EventBridge)

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: M

## Depends on
8-01 (CDK), 8-02 (Aurora), 8-04 (WS fanout consumer)

## Why
Replace Postgres LISTEN/NOTIFY (which doesn't scale across Lambda invocations) with SNS+SQS for event fanout. EventBridge for scheduled jobs (sprint cron, retro cron, hygiene sweeps).

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `infra/lib/constructs/event-bus.ts` | NEW | SNS topic + SQS queues + EventBridge bus |
| `packages/orchestrator/src/events/store.ts` | extend | After DB commit, publish to SNS (only when `ORBITAL_DEPLOY_TARGET=aws`) |
| `packages/orchestrator/src/lambda/consumers/{memory-recorder.ts,defect-router.ts,audit-indexer.ts,replay-recorder.ts}.ts` | NEW | SQS-triggered Lambdas |
| `packages/orchestrator/src/lambda/scheduled/{sprint-planning.ts,retro-runner.ts,hygiene-sweep.ts}.ts` | NEW | EventBridge-triggered Lambdas |

## SNS topic
- Name: `orbital-events-${env}`
- Encryption: KMS
- Message attributes: `tenant_id`, `aggregate_type`, `event_type` (for SNS subscription filter policies)
- Subscriptions:
  - SQS `memory-recorder` (filter: `event_type` IN [MemoryEntryRecorded, MemoryRetrievedForBrief])
  - SQS `defect-router` (filter: `event_type=DefectReported`)
  - SQS `audit-indexer` (filter: all)
  - SQS `replay-recorder` (filter: `event_type` IN [ReplayCaptureCompleted])
  - Lambda `ws-fanout` (no filter — all events go to fanout for connection match)

## SQS queues
Each consumer queue:
- Name: `orbital-${env}-${consumer-name}`
- Encryption: KMS
- Visibility timeout: 60s
- Message retention: 4 days
- DLQ: `orbital-${env}-${consumer-name}-dlq`
- DLQ alarm: depth > 0 → SNS alert
- Source mapping to its consumer Lambda (batch size 10, max batching window 5s)

## EventBridge schedules
Per-env EventBridge bus + rules:
- `sprint-planning-${env}`: cron(0 9 * * ? *) UTC → invoke sprint-planning Lambda
- `retro-runner-${env}`: cron(0 17 * * ? *) UTC → invoke retro Lambda
- `hygiene-sweep-${env}`: rate(1 hour) → invoke hygiene Lambda

Schedules respect tenant timezone — the Lambda reads the tenant's TZ from the `tenants` table and decides whether to actually run for each tenant. (Operator timezones: Lambda runs hourly, decides per-tenant whether their 9am has arrived.)

## Event store extension
`packages/orchestrator/src/events/store.ts` — add post-commit publisher:
```typescript
async append(event: EventInput): Promise<Event> {
  const stored = await this.appendToDb(event)
  if (env.ORBITAL_DEPLOY_TARGET === 'aws') {
    await this.snsClient.publish({
      TopicArn: env.EVENTS_TOPIC_ARN,
      Message: JSON.stringify(stored),
      MessageAttributes: {
        tenant_id: { DataType: 'String', StringValue: stored.tenant_id },
        aggregate_type: { DataType: 'String', StringValue: stored.aggregate_type },
        event_type: { DataType: 'String', StringValue: stored.event_type },
      },
    })
  } else if (env.ORBITAL_MODE === 'local') {
    // existing local LISTEN/NOTIFY path unchanged
  }
  return stored
}
```

The local-self-host mode keeps using LISTEN/NOTIFY — no change. AWS mode uses SNS.

## Consumer Lambdas
Each consumer reads SQS messages in batches:
```typescript
export const handler = async (event: SQSEvent) => {
  const failures: SQSBatchItemFailure[] = []
  for (const record of event.Records) {
    try {
      const message = JSON.parse(record.body)
      const event = JSON.parse(message.Message)
      await processEvent(event)
    } catch (err) {
      failures.push({ itemIdentifier: record.messageId })
    }
  }
  return { batchItemFailures: failures }  // partial-batch retry
}
```

`memory-recorder`: when `MemoryRetrievedForBrief` event → just logs (memory writes happen synchronously in the request path).
`defect-router`: when `DefectReported` → look up `tasks.opened_by_install_id`; if cross-install (Round 7), post to shared channel; else re-spawn the local task.
`audit-indexer`: appends event to a search index (Round 8 v1: just logs to CloudWatch; v2: OpenSearch).
`replay-recorder`: when `ReplayCaptureCompleted` → cross-reference S3 blob and write metadata to a search index for fast lookup.

## Acceptance criteria
1. Hub Lambda inserts an event → SNS publish succeeds → `audit-indexer` Lambda invoked within 5s.
2. `DefectReported` event → only `defect-router` queue receives (filter policy works).
3. SQS DLQ catches a deliberately-broken consumer → alarm fires within 5min.
4. EventBridge schedule fires `sprint-planning` Lambda at 9am UTC.
5. Local-mode hub continues using LISTEN/NOTIFY (regression-clean against the existing local tests).
6. Tenant isolation: `audit-indexer` only processes events for its own tenant (via SNS subscription filter).
7. Throughput: 1000 events/sec sustained without DLQ entries.

## Hard-stop checks
```
grep -E "EventBusConstruct|SnsTopic" infra/lib/constructs/event-bus.ts
grep -E "snsClient.publish|TopicArn" packages/orchestrator/src/events/store.ts
ls packages/orchestrator/src/lambda/consumers/memory-recorder.ts
grep -E "EventBridgeRule|Schedule" infra/lib/constructs/event-bus.ts
```

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round8-05-event-bus]`
