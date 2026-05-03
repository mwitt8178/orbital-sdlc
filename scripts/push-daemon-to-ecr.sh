#!/usr/bin/env bash
# push-daemon-to-ecr.sh — Tag the local daemon image, push to ECR,
# print the digest the operator passes via ORBITAL_DAEMON_IMAGE_DIGEST
# on the next cdk deploy to wire the Fargate Service to the image.
#
# Prereqs:
#   - docker images orbital-daemon:dev (image built locally)
#   - DaemonFargateConstruct deployed (ECR repo orbital-mwitt-daemon exists)
#   - AWS_PROFILE / aws cli configured
#
# Usage:
#   bash scripts/push-daemon-to-ecr.sh [tag]
#
# Default tag is the short git SHA. Tag immutability means each push needs a
# unique tag — the script bails if the tag already exists.

set -euo pipefail

ENV_NAME=${ORBITAL_ENV:-mwitt}
ACCOUNT=${AWS_ACCOUNT_ID:-403001214246}
REGION=${AWS_REGION:-us-east-1}
REPO_NAME="orbital-${ENV_NAME}-daemon"
ECR_HOST="${ACCOUNT}.dkr.ecr.${REGION}.amazonaws.com"
ECR_URI="${ECR_HOST}/${REPO_NAME}"

TAG=${1:-$(git rev-parse --short HEAD)}
echo "Pushing orbital-daemon:dev → ${ECR_URI}:${TAG}"

# Verify local image exists
if ! docker images orbital-daemon:dev --format '{{.ID}}' | grep -q .; then
  echo "FAIL: local image orbital-daemon:dev not found. Build it first:"
  echo "  docker build --platform linux/arm64 -f packages/orchestrator-daemon/Dockerfile -t orbital-daemon:dev ."
  exit 1
fi

# Verify ECR repo exists
if ! aws ecr describe-repositories --repository-names "${REPO_NAME}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: ECR repository ${REPO_NAME} does not exist."
  echo "  Run cdk deploy first to provision the daemon stack."
  exit 1
fi

# Verify tag isn't already taken (immutable repo policy)
if aws ecr describe-images --repository-name "${REPO_NAME}" --image-ids "imageTag=${TAG}" --region "${REGION}" >/dev/null 2>&1; then
  echo "FAIL: tag ${TAG} already exists in ${REPO_NAME}. Pass a different tag."
  exit 1
fi

# ECR login
echo "Logging in to ECR..."
aws ecr get-login-password --region "${REGION}" \
  | docker login --username AWS --password-stdin "${ECR_HOST}"

# Tag + push
docker tag orbital-daemon:dev "${ECR_URI}:${TAG}"
docker push "${ECR_URI}:${TAG}"

# Capture digest
DIGEST=$(aws ecr describe-images --repository-name "${REPO_NAME}" \
  --image-ids "imageTag=${TAG}" \
  --query 'imageDetails[0].imageDigest' --output text --region "${REGION}")

echo
echo "================================================================"
echo "Pushed: ${ECR_URI}:${TAG}"
echo "Digest: ${DIGEST}"
echo
echo "Next step — deploy daemon Fargate service with this image:"
echo "  cd infra && \\"
echo "    ORBITAL_DAEMON_IMAGE_DIGEST=\"${DIGEST}\" \\"
echo "    JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1 \\"
echo "    npx cdk deploy --context env=${ENV_NAME} --require-approval never --output cdk.out.daemon"
echo "================================================================"
