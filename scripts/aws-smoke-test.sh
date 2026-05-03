#!/usr/bin/env bash
# scripts/aws-smoke-test.sh — End-to-end smoke against a deployed AWS env.
#
# Round 8-09 — Cutover + Multi-env Smoke + Deploy Scripts
# [Engineer-Principal · Opus · run-round8-09-cutover-smoke]
#
# Runs 7 health checks against a deployed Orbital env. Designed to be
# called from scripts/deploy-env.sh post-deploy, but safe to run any time.
#
# All 7 checks per architecture.md:
#   1. /health endpoint — public, unauth'd
#   2. Cognito sign-in flow (creates a temp user, signs in, gets JWT)
#   3. Authenticated tRPC call (uses the JWT from step 2)
#   4. WebSocket connect + subscribe + receive (Node script)
#   5. Replay capture roundtrip (write blob to S3 → read back → verify hash)
#   6. Event fanout to SQS (publish SNS event → assert SQS receive)
#   7. Alarm sanity (verify alarms exist and reachable)
#
# Usage:
#   ./scripts/aws-smoke-test.sh mwitt
#
# Optional env vars:
#   ORBITAL_SMOKE_USER_PREFIX    — prefix for the throwaway smoke user (default: smoke)
#   ORBITAL_SMOKE_TIMEOUT_SECS   — per-check timeout (default: 30)
#   ORBITAL_SMOKE_VERBOSE=1      — verbose output
#   ORBITAL_SMOKE_SKIP_LIST=2,4  — comma-separated check numbers to skip
#                                  (e.g., when WS Lambda hasn't been built yet)
#
# Exit codes:
#   0 — all checks passed
#   1 — usage / pre-flight error
#   2 — one or more checks failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_DIR="${PROJECT_ROOT}/infra"

PERSONA="[Engineer-Principal · Opus · run-round8-09-cutover-smoke]"

# ---------------------------------------------------------------------------
# Args + config
# ---------------------------------------------------------------------------

ENV="${1:-}"
if [[ -z "${ENV}" ]]; then
  echo "usage: $0 <env>   (env = mwitt | rreed | prod)" >&2
  exit 1
fi
case "${ENV}" in mwitt|rreed|prod) ;; *) echo "Invalid env '${ENV}'." >&2; exit 1 ;; esac

USER_PREFIX="${ORBITAL_SMOKE_USER_PREFIX:-smoke}"
TIMEOUT="${ORBITAL_SMOKE_TIMEOUT_SECS:-30}"
VERBOSE="${ORBITAL_SMOKE_VERBOSE:-0}"
SKIP_LIST="${ORBITAL_SMOKE_SKIP_LIST:-}"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

PASS=0
FAIL=0
SKIP=0
results=()

pass() { PASS=$(( PASS + 1 )); results+=("  PASS  $1"); }
fail() { FAIL=$(( FAIL + 1 )); results+=("  FAIL  $1"); }
skip() { SKIP=$(( SKIP + 1 )); results+=("  SKIP  $1"); }

check_skipped() {
  local n="$1"
  [[ ",${SKIP_LIST}," == *",${n},"* ]]
}

vlog() {
  [[ "${VERBOSE}" == "1" ]] && printf '       \033[2m%s\033[0m\n' "$*" >&2 || true
}

# Required tools
for cmd in aws curl jq node; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    echo "Required command not found: ${cmd}" >&2
    exit 1
  fi
done

# Read config from cdk.json
if [[ ! -f "${INFRA_DIR}/cdk.json" ]]; then
  echo "cdk.json not found at ${INFRA_DIR}/cdk.json" >&2
  exit 1
fi

DOMAIN=$(jq -r ".context.envs.\"${ENV}\".domain" "${INFRA_DIR}/cdk.json")
REGION=$(jq -r ".context.envs.\"${ENV}\".region" "${INFRA_DIR}/cdk.json")

if [[ -z "${DOMAIN}" || "${DOMAIN}" == "null" ]]; then
  echo "Could not read domain for env=${ENV} from cdk.json" >&2
  exit 1
fi

API_BASE="https://api.${DOMAIN}"
WS_BASE="wss://ws.${DOMAIN}"

# Read deploy outputs (contains user pool IDs, app client IDs, S3 bucket names)
OUTPUTS_FILE="${INFRA_DIR}/cdk.out/outputs-${ENV}.json"
if [[ ! -f "${OUTPUTS_FILE}" ]]; then
  echo "Outputs file not found at ${OUTPUTS_FILE}" >&2
  echo "Run scripts/deploy-env.sh first, or fetch from CloudFormation:" >&2
  echo "  aws cloudformation describe-stacks --region ${REGION} --stack-name OrbitalHub-${ENV} --query 'Stacks[0].Outputs' > ${OUTPUTS_FILE}" >&2
  exit 1
fi

# Extract values from outputs (the CFN output keys are CDK-generated; we
# match by suffix — the construct sets a static suffix per output).
get_output() {
  local key_pattern="$1"
  jq -r ".\"OrbitalHub-${ENV}\" | to_entries[] | select(.key | test(\"${key_pattern}\")) | .value" "${OUTPUTS_FILE}" \
    | head -1
}

USER_POOL_ID=$(get_output 'CognitoUserPoolId|UserPoolId' || echo "")
APP_CLIENT_ID=$(get_output 'CognitoAppClientId|AppClientId' || echo "")
REPLAY_BUCKET=$(get_output 'ReplayBucketName|ReplayBucket' || echo "")
EVENTS_TOPIC_ARN=$(get_output 'EventsTopicArn|SnsTopicArn' || echo "")

# Derive consumer queue URL — predictable name pattern
SQS_QUEUE_URL=""
if QUEUE_URL_RAW=$(aws sqs get-queue-url \
    --queue-name "orbital-${ENV}-audit-indexer" \
    --region "${REGION}" \
    --query QueueUrl --output text 2>/dev/null); then
  SQS_QUEUE_URL="${QUEUE_URL_RAW}"
fi

echo ""
echo "  ============================================================"
echo "  Orbital AWS Smoke — env=${ENV}"
echo "  ${PERSONA}"
echo "  ============================================================"
echo "  API base:       ${API_BASE}"
echo "  WS base:        ${WS_BASE}"
echo "  Region:         ${REGION}"
echo "  User pool:      ${USER_POOL_ID:-<not in outputs>}"
echo "  App client:     ${APP_CLIENT_ID:-<not in outputs>}"
echo "  Replay bucket:  ${REPLAY_BUCKET:-<not in outputs>}"
echo "  Events topic:   ${EVENTS_TOPIC_ARN:-<not in outputs>}"
echo "  Audit queue:    ${SQS_QUEUE_URL:-<not resolvable>}"
echo ""

# ---------------------------------------------------------------------------
# Check 1 — /health endpoint
# ---------------------------------------------------------------------------
echo "  [1/7] GET ${API_BASE}/health"
if check_skipped 1; then
  skip "1. /health (skipped via ORBITAL_SMOKE_SKIP_LIST)"
else
  HEALTH_BODY=""
  HEALTH_CODE=""
  set +e
  HEALTH_BODY=$(curl -fsS --max-time "${TIMEOUT}" -w '\n%{http_code}' "${API_BASE}/health" 2>&1)
  CURL_EXIT=$?
  set -e
  if [[ ${CURL_EXIT} -eq 0 ]]; then
    HEALTH_CODE=$(echo "${HEALTH_BODY}" | tail -1)
    HEALTH_JSON=$(echo "${HEALTH_BODY}" | sed '$d')
    if [[ "${HEALTH_CODE}" == "200" ]]; then
      vlog "Body: ${HEALTH_JSON}"
      if echo "${HEALTH_JSON}" | jq -e '.status' >/dev/null 2>&1; then
        pass "1. /health returned 200 with status field"
      else
        pass "1. /health returned 200 (body shape unverified)"
      fi
    else
      fail "1. /health returned HTTP ${HEALTH_CODE}"
    fi
  else
    fail "1. /health curl failed (exit ${CURL_EXIT})"
  fi
fi

# ---------------------------------------------------------------------------
# Check 2 — Cognito sign-in
# ---------------------------------------------------------------------------
echo "  [2/7] Cognito sign-up + sign-in"
JWT=""
SMOKE_USER=""
if check_skipped 2; then
  skip "2. Cognito sign-in (skipped)"
elif [[ -z "${USER_POOL_ID}" || -z "${APP_CLIENT_ID}" ]]; then
  fail "2. Cognito sign-in — UserPoolId/AppClientId missing from outputs (${OUTPUTS_FILE})"
else
  TS=$(date +%s)
  SMOKE_USER="${USER_PREFIX}-${TS}@orbital-smoke.local"
  SMOKE_PASS="Smoke-$(openssl rand -hex 8)Aa1!"
  vlog "Test user: ${SMOKE_USER}"

  # Use admin-create-user so we don't depend on email delivery
  set +e
  CREATE_OUT=$(aws cognito-idp admin-create-user \
    --region "${REGION}" \
    --user-pool-id "${USER_POOL_ID}" \
    --username "${SMOKE_USER}" \
    --user-attributes Name=email,Value="${SMOKE_USER}" Name=email_verified,Value=true \
    --message-action SUPPRESS \
    --temporary-password "${SMOKE_PASS}" 2>&1)
  CREATE_EXIT=$?
  set -e
  if [[ ${CREATE_EXIT} -ne 0 ]]; then
    fail "2. Cognito admin-create-user failed: ${CREATE_OUT}"
  else
    # Set permanent password (skips FORCE_CHANGE_PASSWORD challenge)
    aws cognito-idp admin-set-user-password \
      --region "${REGION}" \
      --user-pool-id "${USER_POOL_ID}" \
      --username "${SMOKE_USER}" \
      --password "${SMOKE_PASS}" \
      --permanent >/dev/null 2>&1 || true

    # Sign in via USER_PASSWORD_AUTH
    set +e
    AUTH_OUT=$(aws cognito-idp admin-initiate-auth \
      --region "${REGION}" \
      --user-pool-id "${USER_POOL_ID}" \
      --client-id "${APP_CLIENT_ID}" \
      --auth-flow ADMIN_USER_PASSWORD_AUTH \
      --auth-parameters USERNAME="${SMOKE_USER}",PASSWORD="${SMOKE_PASS}" 2>&1)
    AUTH_EXIT=$?
    set -e

    if [[ ${AUTH_EXIT} -ne 0 ]]; then
      fail "2. Cognito admin-initiate-auth failed: ${AUTH_OUT}"
    else
      JWT=$(echo "${AUTH_OUT}" | jq -r '.AuthenticationResult.IdToken // empty')
      if [[ -n "${JWT}" ]]; then
        pass "2. Cognito sign-in succeeded (IdToken length=${#JWT})"
      else
        fail "2. Cognito auth returned no IdToken"
      fi
    fi
  fi
fi

cleanup_smoke_user() {
  if [[ -n "${SMOKE_USER:-}" && -n "${USER_POOL_ID:-}" ]]; then
    aws cognito-idp admin-delete-user \
      --region "${REGION}" \
      --user-pool-id "${USER_POOL_ID}" \
      --username "${SMOKE_USER}" >/dev/null 2>&1 || true
  fi
}
trap cleanup_smoke_user EXIT

# ---------------------------------------------------------------------------
# Check 3 — Authenticated tRPC call
# ---------------------------------------------------------------------------
echo "  [3/7] Authenticated tRPC GET /trpc/team.members"
if check_skipped 3; then
  skip "3. Authenticated tRPC (skipped)"
elif [[ -z "${JWT}" ]]; then
  fail "3. Authenticated tRPC — no JWT (check 2 must pass first)"
else
  set +e
  TRPC_OUT=$(curl -fsS --max-time "${TIMEOUT}" \
    -H "Authorization: Bearer ${JWT}" \
    -w '\n%{http_code}' \
    "${API_BASE}/trpc/team.members" 2>&1)
  TRPC_EXIT=$?
  set -e
  if [[ ${TRPC_EXIT} -eq 0 ]]; then
    TRPC_CODE=$(echo "${TRPC_OUT}" | tail -1)
    TRPC_JSON=$(echo "${TRPC_OUT}" | sed '$d')
    vlog "Body: ${TRPC_JSON}"
    if [[ "${TRPC_CODE}" == "200" ]]; then
      pass "3. Authenticated tRPC returned 200"
    elif [[ "${TRPC_CODE}" == "404" ]]; then
      # Acceptable: no team members for the smoke user. Means auth was OK.
      pass "3. Authenticated tRPC returned 404 (auth OK; no team members yet)"
    else
      fail "3. Authenticated tRPC returned HTTP ${TRPC_CODE}: ${TRPC_JSON:0:200}"
    fi
  else
    fail "3. Authenticated tRPC curl failed (exit ${TRPC_EXIT})"
  fi
fi

# ---------------------------------------------------------------------------
# Check 4 — WebSocket connect + subscribe + receive
# ---------------------------------------------------------------------------
echo "  [4/7] WS connect + subscribe + receive"
if check_skipped 4; then
  skip "4. WS roundtrip (skipped)"
elif [[ -z "${JWT}" ]]; then
  fail "4. WS roundtrip — no JWT (check 2 must pass first)"
else
  WS_TEST_NODE="${SCRIPT_DIR}/.smoke-ws-test.mjs"
  cat > "${WS_TEST_NODE}" <<'WSJS'
// Auto-generated by scripts/aws-smoke-test.sh — WS roundtrip probe.
import WebSocket from 'ws'

const url = process.env.WS_URL
const jwt = process.env.WS_JWT
const timeoutMs = Number(process.env.WS_TIMEOUT || '15000')

if (!url || !jwt) {
  console.error('missing WS_URL or WS_JWT')
  process.exit(2)
}

const ws = new WebSocket(`${url}?token=${encodeURIComponent(jwt)}`)
let acked = false
const timer = setTimeout(() => {
  if (!acked) {
    console.error('WS subscribe ack timeout')
    process.exit(3)
  }
}, timeoutMs)

ws.on('open', () => {
  ws.send(JSON.stringify({ action: 'subscribe', channel: 'smoke' }))
})
ws.on('message', (raw) => {
  acked = true
  clearTimeout(timer)
  process.stdout.write(`ws-message: ${raw.toString().slice(0, 200)}\n`)
  ws.close()
  process.exit(0)
})
ws.on('error', (err) => {
  console.error(`ws-error: ${err.message}`)
  process.exit(4)
})
ws.on('close', () => {
  if (!acked) {
    console.error('ws-closed-before-ack')
    process.exit(5)
  }
})
WSJS

  # Skip if `ws` package is not installed in repo root
  if [[ ! -d "${PROJECT_ROOT}/node_modules/ws" ]]; then
    skip "4. WS roundtrip — 'ws' npm package not installed at repo root"
  else
    set +e
    WS_OUT=$(WS_URL="${WS_BASE}" WS_JWT="${JWT}" WS_TIMEOUT=$(( TIMEOUT * 1000 )) \
      node "${WS_TEST_NODE}" 2>&1)
    WS_EXIT=$?
    set -e
    rm -f "${WS_TEST_NODE}"
    if [[ ${WS_EXIT} -eq 0 ]]; then
      pass "4. WS connect+subscribe+receive succeeded"
      vlog "${WS_OUT}"
    else
      fail "4. WS roundtrip failed (exit ${WS_EXIT}): ${WS_OUT}"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Check 5 — Replay capture roundtrip
# ---------------------------------------------------------------------------
echo "  [5/7] Replay capture roundtrip (S3 + KMS)"
if check_skipped 5; then
  skip "5. Replay roundtrip (skipped)"
elif [[ -z "${REPLAY_BUCKET}" ]]; then
  fail "5. Replay roundtrip — replay bucket name missing from outputs"
else
  REPLAY_KEY="smoke/${ENV}/$(date +%s)-$(openssl rand -hex 8).json"
  REPLAY_BODY="{\"smoke\":\"true\",\"env\":\"${ENV}\",\"ts\":\"$(date -u +%FT%TZ)\"}"
  EXPECTED_HASH=$(printf '%s' "${REPLAY_BODY}" | shasum -a 256 | awk '{print $1}')

  TMP_PUT=$(mktemp)
  TMP_GET=$(mktemp)
  printf '%s' "${REPLAY_BODY}" > "${TMP_PUT}"

  set +e
  PUT_OUT=$(aws s3api put-object \
    --bucket "${REPLAY_BUCKET}" \
    --key "${REPLAY_KEY}" \
    --body "${TMP_PUT}" \
    --content-type 'application/json' \
    --region "${REGION}" 2>&1)
  PUT_EXIT=$?
  set -e
  if [[ ${PUT_EXIT} -ne 0 ]]; then
    fail "5. Replay put-object failed: ${PUT_OUT}"
  else
    set +e
    GET_OUT=$(aws s3api get-object \
      --bucket "${REPLAY_BUCKET}" \
      --key "${REPLAY_KEY}" \
      --region "${REGION}" \
      "${TMP_GET}" 2>&1)
    GET_EXIT=$?
    set -e
    if [[ ${GET_EXIT} -ne 0 ]]; then
      fail "5. Replay get-object failed: ${GET_OUT}"
    else
      ROUNDTRIP_HASH=$(shasum -a 256 < "${TMP_GET}" | awk '{print $1}')
      if [[ "${ROUNDTRIP_HASH}" == "${EXPECTED_HASH}" ]]; then
        pass "5. Replay roundtrip OK (sha256 match: ${EXPECTED_HASH:0:16}...)"
        # Cleanup
        aws s3api delete-object \
          --bucket "${REPLAY_BUCKET}" \
          --key "${REPLAY_KEY}" \
          --region "${REGION}" >/dev/null 2>&1 || true
      else
        fail "5. Replay hash mismatch — expected ${EXPECTED_HASH}, got ${ROUNDTRIP_HASH}"
      fi
    fi
  fi
  rm -f "${TMP_PUT}" "${TMP_GET}"
fi

# ---------------------------------------------------------------------------
# Check 6 — Event fanout to SQS
# ---------------------------------------------------------------------------
echo "  [6/7] SNS publish → SQS receive"
if check_skipped 6; then
  skip "6. Event fanout (skipped)"
elif [[ -z "${EVENTS_TOPIC_ARN}" ]]; then
  fail "6. Event fanout — events topic ARN missing from outputs"
elif [[ -z "${SQS_QUEUE_URL}" ]]; then
  fail "6. Event fanout — could not resolve audit-indexer SQS queue URL"
else
  EVENT_ID="smoke-$(openssl rand -hex 16)"
  EVENT_PAYLOAD=$(jq -nc \
    --arg id "${EVENT_ID}" \
    --arg env "${ENV}" \
    --arg ts "$(date -u +%FT%TZ)" \
    '{event_id:$id, kind:"smoke", env:$env, ts:$ts}')

  set +e
  PUB_OUT=$(aws sns publish \
    --region "${REGION}" \
    --topic-arn "${EVENTS_TOPIC_ARN}" \
    --message "${EVENT_PAYLOAD}" \
    --message-attributes "kind={DataType=String,StringValue=smoke},tenant_id={DataType=String,StringValue=smoke}" 2>&1)
  PUB_EXIT=$?
  set -e
  if [[ ${PUB_EXIT} -ne 0 ]]; then
    fail "6. SNS publish failed: ${PUB_OUT}"
  else
    # Poll the audit queue (longest poll = up to TIMEOUT/3 each)
    POLL_ROUND=$(( TIMEOUT / 5 ))
    [[ ${POLL_ROUND} -lt 1 ]] && POLL_ROUND=1
    FOUND=0
    for _ in $(seq 1 6); do
      MSGS=$(aws sqs receive-message \
        --region "${REGION}" \
        --queue-url "${SQS_QUEUE_URL}" \
        --max-number-of-messages 10 \
        --wait-time-seconds "${POLL_ROUND}" \
        --query 'Messages[].Body' \
        --output text 2>/dev/null || echo "")
      if echo "${MSGS}" | grep -q "${EVENT_ID}"; then
        FOUND=1
        break
      fi
    done
    if [[ ${FOUND} -eq 1 ]]; then
      pass "6. SNS → SQS fanout received event_id=${EVENT_ID}"
    else
      fail "6. SNS → SQS fanout did not deliver event_id=${EVENT_ID} within poll window"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Check 7 — Alarm sanity
# ---------------------------------------------------------------------------
echo "  [7/7] CloudWatch alarms exist + reachable"
if check_skipped 7; then
  skip "7. Alarm sanity (skipped)"
else
  set +e
  ALARM_LIST=$(aws cloudwatch describe-alarms \
    --region "${REGION}" \
    --alarm-name-prefix "orbital-${ENV}-" \
    --query 'MetricAlarms[].AlarmName' \
    --output text 2>&1)
  ALARM_EXIT=$?
  set -e
  if [[ ${ALARM_EXIT} -ne 0 ]]; then
    fail "7. CloudWatch describe-alarms failed: ${ALARM_LIST}"
  else
    ALARM_COUNT=$(echo "${ALARM_LIST}" | wc -w | xargs)
    if [[ ${ALARM_COUNT} -gt 0 ]]; then
      pass "7. Found ${ALARM_COUNT} CloudWatch alarms with prefix 'orbital-${ENV}-'"
      vlog "Alarms: ${ALARM_LIST}"
    else
      fail "7. No CloudWatch alarms with prefix 'orbital-${ENV}-' (8-08 may be incomplete)"
    fi
  fi
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "  ============================================================"
echo "  Smoke results — env=${ENV}"
echo "  ============================================================"
for r in "${results[@]}"; do echo "${r}"; done
echo ""
echo "  PASS: ${PASS}   FAIL: ${FAIL}   SKIP: ${SKIP}"
echo ""

if [[ ${FAIL} -gt 0 ]]; then
  echo "  SMOKE FAILED — investigate failing checks above." >&2
  exit 2
fi
echo "  All smoke checks passed."
exit 0
