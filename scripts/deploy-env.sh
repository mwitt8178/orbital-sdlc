#!/usr/bin/env bash
# scripts/deploy-env.sh — One-command deploy for an Orbital environment.
#
# Round 8-09 — Cutover + Multi-env Smoke + Deploy Scripts
# [Engineer-Principal · Opus · run-round8-09-cutover-smoke]
#
# What this script does:
#   1. Validates the env arg (mwitt | rreed | prod).
#   2. Sanity guard: production deploy refuses unless ALLOW_PROD_DEPLOY=1.
#   3. Pre-flight: install infra deps, synth, then `cdk diff` so the operator
#      sees exactly what will change.
#   4. Confirmation prompt unless ORBITAL_AUTO_APPROVE_DEPLOY=1 is set.
#   5. Runs `cdk deploy --context env=<env> --require-approval never`.
#   6. Runs the post-deploy smoke (scripts/aws-smoke-test.sh) against the env.
#
# Usage:
#   ./scripts/deploy-env.sh mwitt
#   ALLOW_PROD_DEPLOY=1 ./scripts/deploy-env.sh prod
#   ORBITAL_AUTO_APPROVE_DEPLOY=1 ./scripts/deploy-env.sh mwitt
#
# Required env vars (per env, choose one):
#   AWS_PROFILE                       — named profile with credentials, OR
#   AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY — direct creds for CI
#
# Optional env vars:
#   ORBITAL_ACCOUNT_<ENV>             — override account ID for the target env
#   ORBITAL_AUTO_APPROVE_DEPLOY=1     — skip the interactive confirmation prompt
#   ALLOW_PROD_DEPLOY=1               — required for env=prod
#   ORBITAL_SKIP_SMOKE=1              — skip the post-deploy smoke (rare)
#   JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION=1 — quiet JSII Node version warning
#
# Prerequisites:
#   - Node.js 22+
#   - aws CLI v2
#   - AWS credentials configured for the target account
#   - `cdk bootstrap` already run for the target account/region (one-time)
#
# Exit codes:
#   0  — deploy + smoke succeeded
#   1  — usage / pre-flight error
#   2  — operator declined confirmation
#   3  — cdk deploy failed
#   4  — post-deploy smoke failed

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_DIR="${PROJECT_ROOT}/infra"
SMOKE_SCRIPT="${SCRIPT_DIR}/aws-smoke-test.sh"
PRE_DEPLOY_VALIDATE="${SCRIPT_DIR}/pre-deploy-validate.sh"

PERSONA="[Engineer-Principal · Opus · run-round8-09-cutover-smoke]"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

step() { printf '\n  \033[1;34m=>\033[0m %s\n' "$*"; }
ok()   { printf '     \033[1;32m✓\033[0m %s\n' "$*"; }
warn() { printf '     \033[1;33m!\033[0m %s\n' "$*" >&2; }
err()  { printf '     \033[1;31m✗\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Arg parsing + validation
# ---------------------------------------------------------------------------

ENV="${1:-}"
if [[ -z "${ENV}" ]]; then
  err "usage: $0 <env>   (env = mwitt | rreed | prod)"
  exit 1
fi

case "${ENV}" in
  mwitt|rreed|prod) ;;
  *)
    err "Invalid env '${ENV}'. Must be one of: mwitt, rreed, prod."
    exit 1
    ;;
esac

# ---------------------------------------------------------------------------
# Production guardrail
# ---------------------------------------------------------------------------

if [[ "${ENV}" == "prod" ]]; then
  if [[ "${ALLOW_PROD_DEPLOY:-}" != "1" ]]; then
    err "Production deploy requires ALLOW_PROD_DEPLOY=1."
    err "This is a guardrail to prevent accidental prod changes."
    exit 1
  fi
  warn "PRODUCTION DEPLOY — proceeding because ALLOW_PROD_DEPLOY=1 is set."
fi

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------

echo ""
echo "  ============================================================"
echo "  Orbital AWS Deploy — env=${ENV}"
echo "  ${PERSONA}"
echo "  ============================================================"

# ---------------------------------------------------------------------------
# Verify prereqs
# ---------------------------------------------------------------------------

step "Checking prereqs..."
for cmd in node npm aws npx; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    err "Required command not found: ${cmd}"
    exit 1
  fi
done
ok "node, npm, aws, npx all present"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
if [[ "${NODE_MAJOR}" -lt 22 ]]; then
  err "Node.js >= 22 required (found v${NODE_MAJOR})"
  exit 1
fi
ok "Node.js v${NODE_MAJOR} OK"

if ! aws sts get-caller-identity >/dev/null 2>&1; then
  err "aws sts get-caller-identity failed — credentials not configured."
  err "Set AWS_PROFILE=<profile> or export AWS_ACCESS_KEY_ID/SECRET_ACCESS_KEY."
  exit 1
fi
CALLER_ARN=$(aws sts get-caller-identity --query Arn --output text)
ok "AWS credentials OK — caller: ${CALLER_ARN}"

# ---------------------------------------------------------------------------
# Install deps + synth
# ---------------------------------------------------------------------------

step "Installing infra dependencies (npm ci)..."
(cd "${INFRA_DIR}" && npm ci --silent)
ok "Dependencies installed"

step "Synthesizing CDK template (no AWS calls)..."
(cd "${INFRA_DIR}" && npx cdk synth --context env="${ENV}" --quiet)
ok "Synth succeeded - template at ${INFRA_DIR}/cdk.out/OrbitalHub-${ENV}.template.json"

# ---------------------------------------------------------------------------
# Pre-deploy validation
#   Runs the four-stage validator: synth -> cfn-lint -> cycle-check ->
#   cdk deploy --no-execute (AWS-side schema validation without provisioning).
#   Catches CFN-schema, regex, and circular-dep errors BEFORE we burn ~25 min
#   on a real deploy. Set CLAUDE_PREDEPLOY_BYPASS=1 to skip (rare; only for
#   debugging the validator itself).
# ---------------------------------------------------------------------------
if [[ "${CLAUDE_PREDEPLOY_BYPASS:-}" == "1" ]]; then
  warn "CLAUDE_PREDEPLOY_BYPASS=1 - skipping pre-deploy validation (NOT RECOMMENDED)."
else
  if [[ ! -x "${PRE_DEPLOY_VALIDATE}" ]]; then
    if [[ -f "${PRE_DEPLOY_VALIDATE}" ]]; then
      chmod +x "${PRE_DEPLOY_VALIDATE}"
    else
      err "Pre-deploy validator not found at ${PRE_DEPLOY_VALIDATE}"
      exit 1
    fi
  fi

  step "Running pre-deploy validation (4-stage gate)..."
  PREDEPLOY_EXIT=0
  "${PRE_DEPLOY_VALIDATE}" "${ENV}" || PREDEPLOY_EXIT=$?
  if [[ "${PREDEPLOY_EXIT}" -ne 0 ]]; then
    err "Pre-deploy validation FAILED (exit ${PREDEPLOY_EXIT})."
    err "Refusing to call 'cdk deploy' against a template that will not provision."
    err "Fix the issues reported above, then re-run."
    exit 1
  fi
  ok "Pre-deploy validation passed - safe to deploy"
fi

# ---------------------------------------------------------------------------
# CDK diff - show the operator exactly what will change
# ---------------------------------------------------------------------------

step "Computing CDK diff (this calls AWS to read current stack state)..."
echo ""
echo "  ============================================================"
echo "  CDK DIFF — review before approving"
echo "  ============================================================"
# `cdk diff` exits non-zero if there is a diff; we want to capture and continue.
DIFF_EXIT=0
(cd "${INFRA_DIR}" && npx cdk diff --context env="${ENV}") || DIFF_EXIT=$?
echo ""
echo "  ============================================================"

if [[ "${DIFF_EXIT}" -eq 0 ]]; then
  ok "No changes detected — deploy will be a no-op."
elif [[ "${DIFF_EXIT}" -eq 1 ]]; then
  ok "Changes detected — review above."
else
  warn "cdk diff exited with code ${DIFF_EXIT} (non-fatal; continuing)."
fi

# ---------------------------------------------------------------------------
# Confirmation
# ---------------------------------------------------------------------------

if [[ "${ORBITAL_AUTO_APPROVE_DEPLOY:-}" == "1" ]]; then
  warn "ORBITAL_AUTO_APPROVE_DEPLOY=1 — skipping interactive confirmation."
else
  echo ""
  read -rp "Proceed with deploy to env=${ENV}? [y/N]: " CONFIRM
  if [[ "${CONFIRM:-}" != "y" && "${CONFIRM:-}" != "Y" ]]; then
    err "Operator declined. Aborting."
    exit 2
  fi
fi

# Production gets a second confirmation.
if [[ "${ENV}" == "prod" && "${ORBITAL_AUTO_APPROVE_DEPLOY:-}" != "1" ]]; then
  echo ""
  read -rp "Type 'prod' to confirm production deploy: " PROD_CONFIRM
  if [[ "${PROD_CONFIRM}" != "prod" ]]; then
    err "Production confirmation failed. Aborting."
    exit 2
  fi
fi

# ---------------------------------------------------------------------------
# Deploy
# ---------------------------------------------------------------------------

step "Running cdk deploy --context env=${ENV} --require-approval never..."
DEPLOY_START=$(date +%s)
DEPLOY_EXIT=0
(cd "${INFRA_DIR}" && npx cdk deploy \
  --context env="${ENV}" \
  --require-approval never \
  --outputs-file "cdk.out/outputs-${ENV}.json") || DEPLOY_EXIT=$?
DEPLOY_END=$(date +%s)
DEPLOY_DUR=$(( DEPLOY_END - DEPLOY_START ))

if [[ "${DEPLOY_EXIT}" -ne 0 ]]; then
  err "cdk deploy failed (exit ${DEPLOY_EXIT}) after ${DEPLOY_DUR}s"
  exit 3
fi
ok "Deploy completed in ${DEPLOY_DUR}s"
ok "Outputs written to ${INFRA_DIR}/cdk.out/outputs-${ENV}.json"

# ---------------------------------------------------------------------------
# Post-deploy smoke
# ---------------------------------------------------------------------------

if [[ "${ORBITAL_SKIP_SMOKE:-}" == "1" ]]; then
  warn "ORBITAL_SKIP_SMOKE=1 — skipping post-deploy smoke."
else
  step "Running post-deploy smoke (scripts/aws-smoke-test.sh)..."
  if [[ ! -x "${SMOKE_SCRIPT}" ]]; then
    if [[ -f "${SMOKE_SCRIPT}" ]]; then
      chmod +x "${SMOKE_SCRIPT}"
    else
      err "Smoke script not found at ${SMOKE_SCRIPT}"
      exit 4
    fi
  fi

  if ! "${SMOKE_SCRIPT}" "${ENV}"; then
    err "Post-deploy smoke FAILED — review output above."
    err "The deploy itself succeeded; the smoke is the gate."
    err "Investigate or run: ${SMOKE_SCRIPT} ${ENV}"
    exit 4
  fi
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
echo "  ============================================================"
ok "Deploy + smoke complete for env=${ENV}"
echo "  ============================================================"
echo ""
echo "  Stack name: OrbitalHub-${ENV}"
echo "  Outputs:    ${INFRA_DIR}/cdk.out/outputs-${ENV}.json"
echo ""
exit 0
