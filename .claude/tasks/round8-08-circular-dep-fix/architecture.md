# Round 8-08 Circular-Dep Fix — Architecture

[Engineer-Principal · Opus · run-round8-08-circular-dep-fix]

## Bounded contexts touched

- `infra/lib/constructs/event-bus.ts` — KMS keys + SNS topic + SQS queues + SQS event
  source mappings + DLQ alarms

## Aggregate boundaries

`EventBusConstruct` owns:
- KMS key(s) for at-rest encryption of SNS + SQS
- The SNS topic `orbital-events-${env}`
- 4 consumer SQS queues + 4 DLQs
- 3 scheduled-Lambda DLQs (sprint-planning, retro-runner, hygiene-sweep)
- SNS → SQS subscriptions (with filter policies)
- SNS → ws-fanout Lambda subscription
- SQS → consumer Lambda event source mappings
- DLQ depth alarms

## Root cause of failed deploy

A single shared KMS key `EventBusKey` was used for **both** the SNS topic
(`KmsMasterKeyId`) **and** the encrypted SQS queues
(`encryptionMasterKey`).

When `subscriptions.SqsSubscription` is bound, CDK injects a key-policy
statement onto `queue.encryptionMasterKey` granting the SNS service principal
`kms:Decrypt`/`kms:GenerateDataKey` with a condition
`aws:SourceArn = topic.topicArn`. Because the same key is used by the topic,
this produces:

```
SnsTopic       → KmsKey   (via KmsMasterKeyId = GetAtt KmsKey.Arn)
KmsKey         → SnsTopic (via key-policy condition Ref SnsTopic in SourceArn)
```

That 2-resource cycle, transitively closed across every consumer Lambda role,
queue policy, event source mapping, and Observability alarm that participates
in the same dependency island, is what CloudFormation reports as the giant
"circular dependency" list at deploy time.

The feature flag `@aws-cdk/aws-sns-subscriptions:restrictSqsDescryption` is
intentionally set to `true` in `cdk.json` for least-privilege key access; we
keep that flag and break the cycle by splitting the keys instead.

The Observability alarms, EventSourceMappings, IAM role policies, Queue
policies, and HTTP API routes that AWS lists are downstream — they are not
the cause; they are the **scope** of the broken dependency island.

## Event flow (unchanged)

```
Lambda (publisher)
   → SNS topic orbital-events-${env}    [KmsMasterKey = SnsKey]
       → SQS queue per consumer          [encryption = SqsKey]
           → consumer Lambda  (ESM, IAM grants Receive/Delete/KMS-Decrypt against SqsKey)
       → ws-fanout Lambda   (no filter)
```

## Solution — split the encryption key

Replace the single `EventBusKey` with two keys:

1. **`SnsKey`** — alias `orbital-${env}-event-bus-sns`, used as
   `KmsMasterKeyId` for the SNS topic. Receives a key policy statement
   allowing the SNS service principal to encrypt/decrypt against itself.
   No reference to any other resource. **No cycle source.**

2. **`SqsKey`** — alias `orbital-${env}-event-bus-sqs`, used as
   `encryptionMasterKey` for all consumer queues and DLQs. CDK's
   SqsSubscription will add the auto-policy with the SourceArn condition
   to **this** key (not the SNS key), creating:
       `SqsKey → SnsTopic → SnsKey`
   which is acyclic.

The construct exposes:
- `encryptionKey` — the SQS-side key (legacy field, retained for backward
  compat with anything reading it)
- `snsEncryptionKey` — new field exposing the SNS-side key

Lambdas that previously needed `kms:Decrypt` against `encryptionKey` (e.g.
publishers writing to the SNS topic) now need it on `snsEncryptionKey`. CDK
auto-grants this through `topic.grantPublish(...)` and `key.grantDecrypt(...)`,
so callers using `eventBus.grantPublish(role)` keep working.

EventBridge Scheduler + scheduled-Lambda DLQs continue using `SqsKey`.

## IAM diff

| Resource | Before | After |
|---|---|---|
| SNS topic                   | encrypted by `EventBusKey` | encrypted by `SnsKey` |
| Consumer queues + DLQs      | encrypted by `EventBusKey` | encrypted by `SqsKey` |
| Lambda role policies        | `kms:Decrypt` on `EventBusKey.Arn` | `kms:Decrypt` on `SqsKey.Arn` (consumers receiving messages); on `SnsKey.Arn` (publishers via `grantPublish` chain) |
| Key policy `AllowSnsPublish` (SourceArn) | on `EventBusKey` | on `SqsKey` (set by CDK) |

Effective permissions are unchanged — the same set of principals
(SNS service, scheduler service, account root, consumer Lambda roles,
publisher Lambda roles) still have the same actions on the appropriate keys.

## DSQL schema diff

None.

## Blast radius

- Two new KMS keys instead of one. Zero data on the old key (nothing has
  been deployed yet — the previous deploy failed).
- Snapshots: `__snapshots__/snapshot.test.ts.snap` will change. Need
  `vitest -u`.

## Rollback strategy

Pure CDK refactor. If the synth or tests fail, revert the construct
changes and the snapshot.

## Confidence

`confidence: 96`

Rationale: The cycle is reproducible and traced to the exact code path in
aws-cdk-lib (`aws-sns-subscriptions/lib/sqs.js` adds a key-policy entry on
the queue's `encryptionMasterKey` with `aws:SourceArn = topic.topicArn`).
Splitting the keys is the canonical AWS-documented fix for this exact
pattern. The 4% reservation accounts for snapshot drift cleanup +
verifying nothing reaches into the old `encryptionKey` field through
other constructs that I haven't yet read (will be verified by `tsc
--noEmit` after refactor).
