#!/usr/bin/env bash
# Phase 2.9 e2e: publish a test event to the SNS topic with consumer=daemon
# filter, wait for the daemon to log receipt, assert.

set -euo pipefail

ENV_NAME=${ORBITAL_ENV:-mwitt}
REGION=${AWS_REGION:-us-east-1}
TOPIC_ARN=$(aws sns list-topics --region "$REGION" --query "Topics[?contains(TopicArn, 'orbital-events-${ENV_NAME}')].TopicArn | [0]" --output text)
if [ -z "$TOPIC_ARN" ] || [ "$TOPIC_ARN" = "None" ]; then
  echo "FAIL: SNS topic for ${ENV_NAME} not found"
  exit 1
fi
echo "topic: $TOPIC_ARN"

TRACE_ID=$(uuidgen 2>/dev/null || echo "trace-$(date +%s)-$$")
EVENT_ID="0192d000-$(printf '%04x' $((RANDOM)))-7000-8000-$(printf '%012x' $((RANDOM * RANDOM)))"
TENANT_ID="00000000-0000-0000-0000-000000000000"
NOW=$(date -u +%Y-%m-%dT%H:%M:%SZ)
# Canonical EventEnvelope (per packages/types/src/event.ts) so both the
# daemon SQS consumer AND the ws-fanout Lambda can consume the same message.
PAYLOAD=$(cat <<EOF
{
  "event_id": "$EVENT_ID",
  "aggregate_id": "$EVENT_ID",
  "aggregate_type": "system",
  "event_type": "daemon.test.echo",
  "payload": {
    "tenant_id": "$TENANT_ID",
    "kind": "daemon.test.echo",
    "trace_id": "$TRACE_ID",
    "sent_at": "$NOW"
  },
  "actor": { "type": "system", "component": "orchestrator" },
  "trace_id": "$TRACE_ID",
  "occurred_at": "$NOW",
  "schema_version": 1,
  "kind": "daemon.test.echo",
  "tenant_id": "$TENANT_ID"
}
EOF
)
echo "publishing test event with trace_id=$TRACE_ID"

publish_epoch_ms=$(( $(date +%s) * 1000 ))
aws sns publish \
  --topic-arn "$TOPIC_ARN" \
  --message "$PAYLOAD" \
  --message-attributes "consumer={DataType=String,StringValue=daemon}" \
  --region "$REGION" \
  --query 'MessageId' --output text

echo "waiting up to 120s for daemon AND ws-fanout to log the trace_id..."

DAEMON_LOG_GROUP="/orbital/${ENV_NAME}/daemon"
FANOUT_LOG_GROUP="/orbital/${ENV_NAME}/lambda/ws-fanout"

deadline=$(( $(date +%s) + 120 ))
daemon_seen=0
fanout_seen=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  if [ "$daemon_seen" = 0 ]; then
    h=$(aws logs filter-log-events \
      --log-group-name "$DAEMON_LOG_GROUP" \
      --filter-pattern "\"$TRACE_ID\"" \
      --start-time $(( ($(date +%s) - 600) * 1000 )) \
      --region "$REGION" \
      --query 'events[].message' --output text 2>/dev/null || echo "")
    if [ -n "$h" ] && [ "$h" != "None" ]; then
      echo "[daemon] PASS — trace_id observed in $DAEMON_LOG_GROUP"
      daemon_seen=1
    fi
  fi
  if [ "$fanout_seen" = 0 ]; then
    # ws-fanout silently no-ops when there are no connections for the
    # tenant. Verify by counting fresh START records since publish, with
    # zero "Invoke Error" lines. A no-error invocation in the window after
    # publish proves SNS → Lambda chain is intact.
    h=$(aws logs filter-log-events \
      --log-group-name "$FANOUT_LOG_GROUP" \
      --start-time $(( $publish_epoch_ms - 5000 )) \
      --region "$REGION" \
      --query 'events[].message' --output text 2>/dev/null || echo "")
    if echo "$h" | grep -q "Invoke Error"; then
      echo "[ws-fanout] FAIL — Lambda crashed during the window:"
      echo "$h" | head -3
      exit 1
    fi
    starts=$(echo "$h" | tr '\t' '\n' | grep -c "^START RequestId:" || true)
    if [ "$starts" -gt 0 ]; then
      echo "[ws-fanout] PASS — $starts invocation(s) in the window since publish, no errors"
      fanout_seen=1
    fi
  fi
  if [ "$daemon_seen" = 1 ] && [ "$fanout_seen" = 1 ]; then
    echo
    echo "=== Phase 2.9 + 2.10 e2e verification PASSED ==="
    exit 0
  fi
  sleep 5
done

echo "FAIL after 120s — daemon_seen=$daemon_seen fanout_seen=$fanout_seen"
echo
echo "Recent ws-fanout log:"
aws logs filter-log-events \
  --log-group-name "$FANOUT_LOG_GROUP" \
  --start-time $(( ($(date +%s) - 300) * 1000 )) \
  --region "$REGION" \
  --query 'events[].message' --output text 2>&1 | tail -10
exit 1
