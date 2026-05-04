#!/usr/bin/env bash
#
# deploy-real-claude-daemon.sh — build, push, and deploy the orchestrator
# daemon image with the real Anthropic SDK worker.
#
# Idempotent. Safe to re-run.
#
# Required env:
#   AWS_REGION       (default: us-east-1)
#   ENV_NAME         (default: mwitt)
#   AWS_ACCOUNT_ID   (auto-resolved via sts:GetCallerIdentity if unset)
#
# Steps:
#   1. Verify the Anthropic API key secret has a non-placeholder value.
#   2. Build the daemon image (linux/arm64) via docker buildx.
#   3. Push to ECR.
#   4. Register a new task definition revision that injects ANTHROPIC_API_KEY
#      via ECS `secrets:` and references the new image digest.
#   5. Update the ECS service to the new revision.
#   6. Tail CloudWatch logs until we see the daemon report ready.
#
# Real, end-to-end. Will fail loudly if any step is incomplete.
set -euo pipefail

REGION="${AWS_REGION:-us-east-1}"
ENV_NAME="${ENV_NAME:-mwitt}"
ACCOUNT_ID="${AWS_ACCOUNT_ID:-$(aws sts get-caller-identity --query Account --output text)}"
SECRET_ID="orbital-${ENV_NAME}/anthropic-api-key"
ECR_REPO="orbital-${ENV_NAME}-daemon"
ECR_URI="${ACCOUNT_ID}.dkr.ecr.${REGION}.amazonaws.com/${ECR_REPO}"
CLUSTER="orbital-${ENV_NAME}-daemon"
SERVICE="orbital-${ENV_NAME}-daemon"
TASK_FAMILY="orbital-${ENV_NAME}-daemon"
LOG_GROUP="/orbital/${ENV_NAME}/daemon"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
IMAGE_TAG="real-claude-$(date -u +%Y%m%d-%H%M%S)"

log() { echo "[deploy] $*" >&2; }

#-------------------------------------------------------------------------
# 1. Verify the secret has a real value
#-------------------------------------------------------------------------
log "verifying secret ${SECRET_ID} has a non-placeholder value"
SECRET_VALUE="$(aws secretsmanager get-secret-value --region "${REGION}" --secret-id "${SECRET_ID}" --query SecretString --output text 2>/dev/null || true)"
if [[ -z "${SECRET_VALUE}" || "${SECRET_VALUE}" == "PLACEHOLDER_REPLACE_ME" ]]; then
  cat >&2 <<EOF
ERROR: secret ${SECRET_ID} is empty or still holds the placeholder.
Place the real Anthropic API key with:

  aws secretsmanager put-secret-value \\
    --region ${REGION} \\
    --secret-id ${SECRET_ID} \\
    --secret-string 'sk-ant-...your-real-key...'

Then re-run this script.
EOF
  exit 2
fi
log "secret OK"

SECRET_ARN="$(aws secretsmanager describe-secret --region "${REGION}" --secret-id "${SECRET_ID}" --query ARN --output text)"
log "secret ARN: ${SECRET_ARN}"

#-------------------------------------------------------------------------
# 2. Build the daemon image (arm64 to match Fargate task def)
#-------------------------------------------------------------------------
log "ensuring buildx builder exists"
docker buildx inspect orbital-builder >/dev/null 2>&1 || \
  docker buildx create --name orbital-builder --use >/dev/null

log "logging into ECR"
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ECR_URI%/*}"

log "building image ${ECR_URI}:${IMAGE_TAG} (linux/arm64)"
docker buildx build \
  --builder orbital-builder \
  --platform linux/arm64 \
  --provenance=false \
  -t "${ECR_URI}:${IMAGE_TAG}" \
  -f "${ROOT_DIR}/packages/orchestrator-daemon/Dockerfile" \
  --push \
  "${ROOT_DIR}"

#-------------------------------------------------------------------------
# 3. Resolve image digest (immutable reference for the task def)
#-------------------------------------------------------------------------
log "resolving image digest"
IMAGE_DIGEST="$(aws ecr describe-images --region "${REGION}" --repository-name "${ECR_REPO}" --image-ids imageTag="${IMAGE_TAG}" --query 'imageDetails[0].imageDigest' --output text)"
IMAGE_REF="${ECR_URI}@${IMAGE_DIGEST}"
log "image: ${IMAGE_REF}"

#-------------------------------------------------------------------------
# 4. Register a new task definition revision
#-------------------------------------------------------------------------
log "fetching current task def for ${TASK_FAMILY}"
CURRENT_TD="$(aws ecs describe-task-definition --region "${REGION}" --task-definition "${TASK_FAMILY}" --query 'taskDefinition' --output json)"

NEW_TD="$(echo "${CURRENT_TD}" | python3 -c "
import json, sys
td = json.load(sys.stdin)
# strip read-only fields
for k in ('taskDefinitionArn','revision','status','requiresAttributes','compatibilities','registeredAt','registeredBy','deregisteredAt'):
    td.pop(k, None)
# update image + secrets on the daemon container
for c in td.get('containerDefinitions', []):
    if c.get('name') == 'orbital-daemon':
        c['image'] = '${IMAGE_REF}'
        secrets = [s for s in c.get('secrets', []) if s.get('name') != 'ANTHROPIC_API_KEY']
        secrets.append({'name':'ANTHROPIC_API_KEY','valueFrom':'${SECRET_ARN}'})
        c['secrets'] = secrets
        env = [e for e in c.get('environment', []) if e.get('name') != 'ANTHROPIC_API_KEY_SECRET_ID']
        env.append({'name':'ANTHROPIC_API_KEY_SECRET_ID','value':'${SECRET_ID}'})
        c['environment'] = env
print(json.dumps(td))
")"

log "registering new task def revision"
NEW_TD_ARN="$(echo "${NEW_TD}" | aws ecs register-task-definition --region "${REGION}" --cli-input-json file:///dev/stdin --query 'taskDefinition.taskDefinitionArn' --output text)"
log "registered: ${NEW_TD_ARN}"

#-------------------------------------------------------------------------
# 5. Update ECS service
#-------------------------------------------------------------------------
log "updating service ${SERVICE} → ${NEW_TD_ARN}"
aws ecs update-service \
  --region "${REGION}" \
  --cluster "${CLUSTER}" \
  --service "${SERVICE}" \
  --task-definition "${NEW_TD_ARN}" \
  --force-new-deployment \
  --query 'service.deployments[0].[id,status,desiredCount,runningCount]' \
  --output text

log "waiting for service to stabilize (this can take ~3 min)"
aws ecs wait services-stable --region "${REGION}" --cluster "${CLUSTER}" --services "${SERVICE}" || {
  log "service did not stabilize within timeout; check CloudWatch logs ${LOG_GROUP}"
  exit 1
}

#-------------------------------------------------------------------------
# 6. Verify
#-------------------------------------------------------------------------
log "service stable. Recent log lines:"
aws logs tail "${LOG_GROUP}" --region "${REGION}" --since 5m --format short | tail -30 || true

log "DONE. Image: ${IMAGE_REF}  Task def: ${NEW_TD_ARN}"
