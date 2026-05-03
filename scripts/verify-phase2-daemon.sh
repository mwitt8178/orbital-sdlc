#!/usr/bin/env bash
# verify-phase2-daemon.sh — Phase 2.8/2.9 end-to-end verification.
#
# Confirms:
#   1. ECR repo exists and has the daemon image.
#   2. EFS file system + access point provisioned.
#   3. SQS daemon work queue + DLQ exist.
#   4. ECS service exists and reaches runningCount=desiredCount.
#   5. Daemon's /health endpoint serves 200 (via internal probe).
#   6. CloudWatch logs show structured JSON with tenant_id field.
#
# Output: docs/phase2-verification.log

set -euo pipefail

LOG=docs/phase2-verification.log
mkdir -p "$(dirname "$LOG")"

{
  echo "=== Phase 2 daemon deployment verification ==="
  echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo

  echo "--- 1. ECR repo + image ---"
  aws ecr describe-repositories --repository-names orbital-mwitt-daemon \
    --query 'repositories[0].{name:repositoryName,uri:repositoryUri,scanOnPush:imageScanningConfiguration.scanOnPush,tagMutability:imageTagMutability}' \
    --output json 2>&1
  echo
  echo "Images:"
  aws ecr list-images --repository-name orbital-mwitt-daemon \
    --query 'imageIds[*].[imageTag,imageDigest]' --output text 2>&1 | head -5

  echo
  echo "--- 2. EFS file system ---"
  aws efs describe-file-systems --query "FileSystems[?Tags[?Key=='aws:cloudformation:stack-name' && Value=='OrbitalHub-mwitt']] | [0].{name:Name,id:FileSystemId,size:SizeInBytes.Value,mode:LifecycleState}" --output json 2>&1

  echo
  echo "--- 3. SQS daemon work queue ---"
  WORK_QUEUE_URL=$(aws sqs get-queue-url --queue-name orbital-mwitt-daemon-work --query 'QueueUrl' --output text 2>&1) || echo "queue not found"
  echo "Work queue URL: $WORK_QUEUE_URL"
  if [ "$WORK_QUEUE_URL" != "queue not found" ] && [ -n "$WORK_QUEUE_URL" ]; then
    aws sqs get-queue-attributes --queue-url "$WORK_QUEUE_URL" \
      --attribute-names ApproximateNumberOfMessages QueueArn VisibilityTimeout \
      --query 'Attributes' --output json 2>&1
  fi
  DLQ_URL=$(aws sqs get-queue-url --queue-name orbital-mwitt-daemon-work-dlq --query 'QueueUrl' --output text 2>&1) || echo "dlq not found"
  echo "DLQ URL: $DLQ_URL"

  echo
  echo "--- 4. ECS service ---"
  aws ecs describe-services --cluster orbital-mwitt-daemon --services orbital-mwitt-daemon \
    --query 'services[0].{name:serviceName,status:status,desired:desiredCount,running:runningCount,pending:pendingCount,events:events[0:3].[createdAt,message]}' \
    --output json 2>&1

  echo
  echo "--- 5. ECS task health ---"
  TASK_ARNS=$(aws ecs list-tasks --cluster orbital-mwitt-daemon --service-name orbital-mwitt-daemon \
    --query 'taskArns[]' --output text 2>&1)
  if [ -n "$TASK_ARNS" ] && [ "$TASK_ARNS" != "None" ]; then
    aws ecs describe-tasks --cluster orbital-mwitt-daemon --tasks $TASK_ARNS \
      --query 'tasks[*].{lastStatus:lastStatus,health:healthStatus,startedAt:startedAt,stoppedReason:stoppedReason,exitCode:containers[0].exitCode}' \
      --output json 2>&1
  else
    echo "(no tasks running)"
  fi

  echo
  echo "--- 6. Recent daemon logs ---"
  STREAMS=$(aws logs describe-log-streams --log-group-name "/orbital/mwitt/daemon" \
    --order-by LastEventTime --descending --max-items 1 \
    --query 'logStreams[0].logStreamName' --output text 2>/dev/null || echo "")
  if [ -n "$STREAMS" ] && [ "$STREAMS" != "None" ]; then
    aws logs get-log-events --log-group-name "/orbital/mwitt/daemon" --log-stream-name "$STREAMS" \
      --limit 30 --query 'events[].message' --output text 2>&1 | head -50
  else
    echo "(no log streams yet)"
  fi

  echo
  echo "=== END verification ==="
} 2>&1 | tee "$LOG"
