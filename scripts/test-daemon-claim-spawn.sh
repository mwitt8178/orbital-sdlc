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
PAYLOAD=$(cat <<EOF
{"kind":"daemon.test.echo","tenant_id":"00000000-0000-0000-0000-000000000000","trace_id":"$TRACE_ID","sent_at":"$(date -u +%Y-%m-%dT%H:%M:%SZ)"}
EOF
)
echo "publishing test event with trace_id=$TRACE_ID"

aws sns publish \
  --topic-arn "$TOPIC_ARN" \
  --message "$PAYLOAD" \
  --message-attributes "consumer={DataType=String,StringValue=daemon}" \
  --region "$REGION" \
  --query 'MessageId' --output text

echo "waiting up to 120s for daemon log line containing trace_id..."

LOG_GROUP="/orbital/${ENV_NAME}/daemon"
deadline=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  hits=$(aws logs filter-log-events \
    --log-group-name "$LOG_GROUP" \
    --filter-pattern "\"$TRACE_ID\"" \
    --start-time $(( ($(date +%s) - 600) * 1000 )) \
    --region "$REGION" \
    --query 'events[].message' --output text 2>/dev/null || echo "")
  if [ -n "$hits" ] && [ "$hits" != "None" ]; then
    echo
    echo "=== HIT: daemon received the event ==="
    echo "$hits" | head -3
    echo "=== Phase 2.9 verification PASSED ==="
    exit 0
  fi
  sleep 5
done

echo "FAIL: no daemon log line containing trace_id $TRACE_ID found within 120s"
echo
echo "Recent daemon log:"
aws logs filter-log-events \
  --log-group-name "$LOG_GROUP" \
  --start-time $(( ($(date +%s) - 300) * 1000 )) \
  --region "$REGION" \
  --query 'events[].message' --output text 2>&1 | tail -20
exit 1
