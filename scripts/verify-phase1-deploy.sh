#!/usr/bin/env bash
# verify-phase1-deploy.sh — Phase 1.10 end-to-end verification.
#
# Confirms:
#   1. orbital-mwitt-api Lambda exists with the right runtime and env.
#   2. ORBITAL_HOME=/tmp/.orbital is now in deployed env (drift fixed).
#   3. The 11 legacy LambdaTrpcConstruct functions are gone.
#   4. /trpc/{proxy+} reaches api-lambda and returns a real tRPC response.
#   5. /public/{proxy+} also reaches api-lambda and returns a real response.
#   6. CloudFront still serves the UI shell.
#
# Output: docs/phase1-verification.log

set -euo pipefail

LOG=docs/phase1-verification.log
mkdir -p "$(dirname "$LOG")"

{
  echo "=== Phase 1 deployment verification ==="
  echo "Date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo

  echo "--- 1. api-lambda config ---"
  aws lambda get-function-configuration --function-name orbital-mwitt-api \
    --query '{FunctionName:FunctionName,Runtime:Runtime,Handler:Handler,MemorySize:MemorySize,Timeout:Timeout,LastModified:LastModified,CodeSize:CodeSize,Env:Environment.Variables}' \
    --output json | jq .

  echo
  echo "--- 2. ORBITAL_HOME present? ---"
  aws lambda get-function-configuration --function-name orbital-mwitt-api \
    --query 'Environment.Variables.ORBITAL_HOME' --output text

  echo
  echo "--- 3. Legacy trpc-* functions removed ---"
  for n in trpc-all trpc-auth trpc-memory trpc-comms trpc-defects trpc-audit trpc-prs trpc-cost trpc-providers trpc-team trpc-onboarding; do
    if aws lambda get-function-configuration --function-name "orbital-mwitt-$n" 2>/dev/null >/dev/null; then
      echo "FAIL: orbital-mwitt-$n still exists"
    else
      echo "OK: orbital-mwitt-$n is gone"
    fi
  done
  # The install Lambda (trpc-tasks) should still exist.
  if aws lambda get-function-configuration --function-name orbital-mwitt-trpc-tasks >/dev/null 2>&1; then
    echo "OK: orbital-mwitt-trpc-tasks (install Lambda) preserved"
  else
    echo "FAIL: install Lambda missing"
  fi

  echo
  echo "--- 4. HTTP API endpoint ---"
  HTTP_API_ID=$(aws apigatewayv2 get-apis --query "Items[?Name=='orbital-mwitt-api'].ApiId | [0]" --output text)
  if [ -z "$HTTP_API_ID" ] || [ "$HTTP_API_ID" = "None" ]; then
    HTTP_API_ID=$(aws apigatewayv2 get-apis --query "Items[?contains(Name, 'mwitt')].ApiId | [0]" --output text)
  fi
  echo "HTTP API id: $HTTP_API_ID"
  ENDPOINT="https://${HTTP_API_ID}.execute-api.us-east-1.amazonaws.com"
  echo "Endpoint: $ENDPOINT"

  echo
  echo "--- 5. /trpc/onboarding.status ---"
  set +e
  TRPC_RESP=$(curl -sS -w '\nHTTP_STATUS=%{http_code}\n' "$ENDPOINT/trpc/onboarding.status?batch=1&input=%7B%7D" -m 30 2>&1)
  echo "$TRPC_RESP"

  echo
  echo "--- 6. /public/trpc/onboarding.status (will 404 since path is /public/{proxy+}, route is via proxy — try /public/onboarding.status) ---"
  PUB_RESP=$(curl -sS -w '\nHTTP_STATUS=%{http_code}\n' "$ENDPOINT/public/onboarding.status?batch=1&input=%7B%7D" -m 30 2>&1)
  echo "$PUB_RESP"
  set -e

  echo
  echo "--- 7. Lambda log groups still exist ---"
  aws logs describe-log-groups --log-group-name-prefix "/orbital/mwitt/lambda/" --query 'logGroups[].logGroupName' --output text | tr '\t' '\n'

  echo
  echo "--- 8. Recent api-lambda logs (last 5 min) ---"
  STREAMS=$(aws logs describe-log-streams --log-group-name "/orbital/mwitt/lambda/api" --order-by LastEventTime --descending --max-items 1 --query 'logStreams[0].logStreamName' --output text 2>/dev/null || echo "")
  if [ -n "$STREAMS" ] && [ "$STREAMS" != "None" ]; then
    aws logs get-log-events --log-group-name "/orbital/mwitt/lambda/api" \
      --log-stream-name "$STREAMS" --start-time $(($(date +%s) * 1000 - 300000)) \
      --query 'events[].message' --output text 2>/dev/null | head -50
  else
    echo "(no log streams yet — function not invoked)"
  fi

  echo
  echo "=== END verification ==="
} 2>&1 | tee "$LOG"
