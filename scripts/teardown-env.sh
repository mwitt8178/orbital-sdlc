#!/usr/bin/env bash
# scripts/teardown-env.sh — One-command teardown for non-prod envs.
#
# Round 8-09 — Cutover + Multi-env Smoke + Deploy Scripts
# [Engineer-Principal · Opus · run-round8-09-cutover-smoke]
#
# Refuses to operate on prod. Production teardown is a manual procedure
# documented in docs/aws-rollback.md (you must disable termination
# protection and call cdk destroy by hand).
#
# What this script does:
#   1. Refuses if ENV=prod.
#   2. Double-confirms by requiring the operator to retype the env name.
#   3. Runs `cdk destroy --context env=<env> --force`.
#   4. Verifies CloudFormation has no remaining stacks for the env.
#
# Usage:
#   ./scripts/teardown-env.sh mwitt
#
# The double confirmation cannot be skipped (no auto-approve flag).
# Tearing down is destructive; we want a human in the loop.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_DIR="${PROJECT_ROOT}/infra"

PERSONA="[Engineer-Principal · Opus · run-round8-09-cutover-smoke]"

step() { printf '\n  \033[1;34m=>\033[0m %s\n' "$*"; }
ok()   { printf '     \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '     \033[1;33m!\033[0m %s\n' "$*" >&2; }
err()  { printf '     \033[1;31m✗\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Arg + safety checks
# ---------------------------------------------------------------------------

ENV="${1:-}"
if [[ -z "${ENV}" ]]; then
  err "usage: $0 <env>   (env = mwitt | rreed)"
  err "Production teardown is documented manually in docs/aws-rollback.md."
  exit 1
fi

if [[ "${ENV}" == "prod" ]]; then
  err "REFUSE: production teardown is NOT performed via this script."
  err "Production teardown procedure: see docs/aws-rollback.md section 'Production Teardown'."
  exit 1
fi

case "${ENV}" in
  mwitt|rreed) ;;
  *)
    err "Invalid env '${ENV}'. Must be one of: mwitt, rreed."
    exit 1
    ;;
esac

echo ""
echo "  ============================================================"
echo "  Orbital AWS TEARDOWN — env=${ENV}"
echo "  ${PERSONA}"
echo "  ============================================================"
warn "This will DESTROY all resources in OrbitalHub-${ENV}, including:"
warn "  - Aurora cluster (data loss — backups retained per Aurora policy)"
warn "  - DynamoDB connections table"
warn "  - S3 buckets (replay blobs + UI assets)"
warn "  - Cognito user pool (all users dropped)"
warn "  - VPC + all networking"
warn ""
warn "There is NO undo. Existing automated backups remain in AWS until their TTL."
echo ""

# ---------------------------------------------------------------------------
# Verify creds + non-prod account check
# ---------------------------------------------------------------------------

step "Checking AWS creds + account ID..."
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  err "aws sts get-caller-identity failed — credentials not configured."
  exit 1
fi

CALLER_ARN=$(aws sts get-caller-identity --query Arn --output text)
CALLER_ACCT=$(aws sts get-caller-identity --query Account --output text)
ok "Caller: ${CALLER_ARN} (account ${CALLER_ACCT})"

# Read the expected account from cdk.json (sanity guard so we don't
# accidentally tear down the wrong account if AWS_PROFILE is misconfigured).
EXPECTED_ACCT=""
if command -v jq >/dev/null 2>&1 && [[ -f "${INFRA_DIR}/cdk.json" ]]; then
  EXPECTED_ACCT=$(jq -r ".context.envs.\"${ENV}\".account // \"\"" "${INFRA_DIR}/cdk.json")
fi
ENV_VAR_NAME="ORBITAL_ACCOUNT_$(echo "${ENV}" | tr '[:lower:]' '[:upper:]')"
ENV_OVERRIDE="${!ENV_VAR_NAME:-}"
if [[ -n "${ENV_OVERRIDE}" ]]; then
  EXPECTED_ACCT="${ENV_OVERRIDE}"
fi

if [[ -n "${EXPECTED_ACCT}" && "${EXPECTED_ACCT}" != "<TBD>" && "${EXPECTED_ACCT}" != "${CALLER_ACCT}" ]]; then
  err "Account mismatch: caller is ${CALLER_ACCT}, but env=${ENV} expects ${EXPECTED_ACCT}."
  err "Refusing to tear down the wrong account. Fix AWS_PROFILE or ${ENV_VAR_NAME} and retry."
  exit 1
fi

# ---------------------------------------------------------------------------
# Double confirmation — must retype the env name
# ---------------------------------------------------------------------------

echo ""
read -rp "Type the env name '${ENV}' to confirm teardown: " CONFIRM1
if [[ "${CONFIRM1}" != "${ENV}" ]]; then
  err "Env name mismatch. Aborting."
  exit 1
fi

read -rp "Type 'destroy' to confirm: " CONFIRM2
if [[ "${CONFIRM2}" != "destroy" ]]; then
  err "Confirmation failed. Aborting."
  exit 1
fi

# ---------------------------------------------------------------------------
# Run cdk destroy
# ---------------------------------------------------------------------------

step "Running cdk destroy --context env=${ENV} --force..."
TEAR_START=$(date +%s)
TEAR_EXIT=0
(cd "${INFRA_DIR}" && npx cdk destroy --context env="${ENV}" --force) || TEAR_EXIT=$?
TEAR_END=$(date +%s)
TEAR_DUR=$(( TEAR_END - TEAR_START ))

if [[ "${TEAR_EXIT}" -ne 0 ]]; then
  err "cdk destroy failed (exit ${TEAR_EXIT}) after ${TEAR_DUR}s"
  err "Some resources may remain. Investigate via:"
  err "  aws cloudformation describe-stacks --stack-name OrbitalHub-${ENV}"
  exit "${TEAR_EXIT}"
fi
ok "cdk destroy completed in ${TEAR_DUR}s"

# ---------------------------------------------------------------------------
# Post-teardown verification
# ---------------------------------------------------------------------------

step "Verifying no OrbitalHub-${ENV} stack remains..."
REGION="$(jq -r ".context.envs.\"${ENV}\".region // \"us-east-1\"" "${INFRA_DIR}/cdk.json" 2>/dev/null || echo us-east-1)"
REMAINING=$(aws cloudformation list-stacks \
  --region "${REGION}" \
  --query "StackSummaries[?StackName=='OrbitalHub-${ENV}' && StackStatus!='DELETE_COMPLETE'].StackName" \
  --output text 2>/dev/null || true)

if [[ -n "${REMAINING}" ]]; then
  warn "Stack still present: ${REMAINING}"
  warn "It may be in DELETE_IN_PROGRESS — wait and re-check with:"
  warn "  aws cloudformation describe-stacks --region ${REGION} --stack-name OrbitalHub-${ENV}"
else
  ok "No active OrbitalHub-${ENV} stack remains."
fi

echo ""
echo "  ============================================================"
ok "Teardown complete for env=${ENV}"
echo "  ============================================================"
echo ""
echo "  Note: Some resources outside the stack may have been retained:"
echo "    - Aurora final snapshots (per cluster removal policy)"
echo "    - CloudWatch log groups (kept for forensics)"
echo "    - S3 buckets in production envs (ObjectLock prevents immediate delete)"
echo ""
echo "  Cost should drop within ~1h. Verify with the AWS Cost Explorer."
echo ""
exit 0
