#!/usr/bin/env bash
# scripts/pre-deploy-validate.sh — Comprehensive CDK pre-deploy validation.
#
# [Engineer-Principal · Opus · run-round8-pre-deploy-validation]
#
# Runs four progressively-stricter validation stages against a synthesized
# CDK template before allowing `cdk deploy` to start. Catches schema, regex,
# parameter-incompatibility, and circular-dependency errors that would
# otherwise only surface mid-deploy and burn ~25 min per failed attempt.
#
# Stages (fail-fast):
#   1. cdk synth                  -> CFN template generation
#   2. cfn-lint                   -> CFN schema + regex validation (offline)
#   3. cycle-check.ts             -> Tarjan SCC on Refs/GetAtts/DependsOn graph
#   4. cdk deploy --no-execute    -> AWS-side changeset validation (no provisioning)
#
# Usage:
#   scripts/pre-deploy-validate.sh <env>
#
# Required tooling:
#   - node, npm, npx
#   - aws CLI (for stage 4 changeset)
#   - python 3.11+ for the local cfn-lint venv (auto-bootstrapped to .venv-cfn-lint)
#
# Exit codes:
#   0 = all stages passed
#   1 = stage 1 (synth) failed
#   2 = stage 2 (cfn-lint) found errors
#   3 = stage 3 (cycle-check) found cycles
#   4 = stage 4 (no-execute changeset) was rejected by AWS
#  10 = setup error (missing tooling, can't bootstrap venv, etc.)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INFRA_DIR="${PROJECT_ROOT}/infra"
VENV_DIR="${PROJECT_ROOT}/.venv-cfn-lint"
CYCLE_CHECK_TS="${SCRIPT_DIR}/cycle-check.ts"

PERSONA="[Engineer-Principal · Opus · run-round8-pre-deploy-validation]"

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

# Print helpers (ANSI colour). All go to stderr so the operator can pipe
# stdout (e.g. JSON results) without noise interleaving.
step() { printf '\n  \033[1;34m=>\033[0m %s\n' "$*" >&2; }
ok()   { printf '     \033[1;32mok\033[0m %s\n' "$*" >&2; }
warn() { printf '     \033[1;33m!\033[0m %s\n' "$*" >&2; }
err()  { printf '     \033[1;31mfail\033[0m %s\n' "$*" >&2; }

# ---------------------------------------------------------------------------
# Arg validation
# ---------------------------------------------------------------------------

ENV="${1:-}"
if [[ -z "${ENV}" ]]; then
  err "usage: $0 <env>   (env = mwitt | rreed | prod)"
  exit 10
fi

case "${ENV}" in
  mwitt|rreed|prod) ;;
  *)
    err "Invalid env '${ENV}'. Must be one of: mwitt, rreed, prod."
    exit 10
    ;;
esac

STACK_NAME="OrbitalHub-${ENV}"
TEMPLATE_PATH="${INFRA_DIR}/cdk.out/${STACK_NAME}.template.json"

# Banner
echo "" >&2
echo "  ============================================================" >&2
echo "  Orbital pre-deploy validation - env=${ENV}" >&2
echo "  ${PERSONA}" >&2
echo "  ============================================================" >&2

# ---------------------------------------------------------------------------
# Tooling bootstrap
# ---------------------------------------------------------------------------

require_cmd() {
  if ! command -v "$1" >/dev/null 2>&1; then
    err "Required command not found: $1"
    exit 10
  fi
}

require_cmd node
require_cmd npm
require_cmd npx
require_cmd aws

# Find a Python that can host cfn-lint. cfn-lint requires Python 3.9+.
# Some macOS systems have a broken latest-Python (e.g. 3.14 with missing
# pyexpat symbols); prefer 3.11 -> 3.12 -> 3.13 -> 3.14 -> python3 in that order.
choose_python() {
  for candidate in python3.13 python3.12 python3.11 python3.14 python3; do
    if command -v "${candidate}" >/dev/null 2>&1; then
      # Smoke-test: can the interpreter import xml.parsers.expat? cfn-lint
      # needs it transitively.
      if "${candidate}" -c 'import xml.parsers.expat' >/dev/null 2>&1; then
        echo "${candidate}"
        return 0
      fi
    fi
  done
  return 1
}

ensure_cfn_lint() {
  if [[ -x "${VENV_DIR}/bin/cfn-lint" ]]; then
    return 0
  fi

  step "Bootstrapping cfn-lint into ${VENV_DIR}..."
  PY="$(choose_python || true)"
  if [[ -z "${PY}" ]]; then
    err "No working Python 3.9+ found (tried python3.11/12/13/14/python3)."
    err "Install via: brew install python@3.13"
    exit 10
  fi

  if ! "${PY}" -m venv "${VENV_DIR}" 2>/dev/null; then
    err "Failed to create venv at ${VENV_DIR} using ${PY}"
    exit 10
  fi

  if ! "${VENV_DIR}/bin/pip" install --quiet --upgrade pip cfn-lint >/dev/null 2>&1; then
    err "pip install of cfn-lint failed; rerun with verbose pip to debug:"
    err "  ${VENV_DIR}/bin/pip install --upgrade pip cfn-lint"
    exit 10
  fi

  ok "cfn-lint $(${VENV_DIR}/bin/cfn-lint --version) installed"
}

ensure_cfn_lint

# ---------------------------------------------------------------------------
# Stage 1: synth
# ---------------------------------------------------------------------------

step "Stage 1/4: cdk synth (CFN template generation)..."
SYNTH_LOG="$(mktemp -t orbital-synth.XXXXXX.log)"
SYNTH_EXIT=0
(
  cd "${INFRA_DIR}"
  JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION="${JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION:-1}" \
    npx cdk synth --context env="${ENV}" --quiet
) >"${SYNTH_LOG}" 2>&1 || SYNTH_EXIT=$?

if [[ "${SYNTH_EXIT}" -ne 0 ]]; then
  err "cdk synth failed (exit ${SYNTH_EXIT})"
  echo "" >&2
  cat "${SYNTH_LOG}" >&2
  rm -f "${SYNTH_LOG}"
  exit 1
fi

if [[ ! -f "${TEMPLATE_PATH}" ]]; then
  err "Synth completed but template not found at ${TEMPLATE_PATH}"
  rm -f "${SYNTH_LOG}"
  exit 1
fi

TEMPLATE_SIZE_KB=$(( $(wc -c < "${TEMPLATE_PATH}") / 1024 ))
RESOURCE_COUNT=$(node -e "
  const t = require('${TEMPLATE_PATH}')
  console.log(Object.keys(t.Resources || {}).length)
")
ok "Synth ok - template ${TEMPLATE_SIZE_KB}KB, ${RESOURCE_COUNT} resources"
rm -f "${SYNTH_LOG}"

# ---------------------------------------------------------------------------
# Stage 2: cfn-lint
# ---------------------------------------------------------------------------

step "Stage 2/4: cfn-lint (CFN schema + regex validation)..."
LINT_LOG="$(mktemp -t orbital-cfn-lint.XXXXXX.log)"
# cfn-lint exits:
#   0 = all good (or only informational notes)
#   2 = warnings only (non-fatal for our purposes - e.g. EOL Lambda runtime)
#   4 = errors
#   6 = errors + warnings
#   8 = informational
# We treat 2 (warnings) as non-fatal but report.
LINT_EXIT=0
"${VENV_DIR}/bin/cfn-lint" "${TEMPLATE_PATH}" >"${LINT_LOG}" 2>&1 || LINT_EXIT=$?

# Extract any actual errors (lines starting with E) regardless of exit code,
# since cfn-lint sometimes returns 0 even when an "Error" rule fired in older
# versions. Defensive parse.
ERROR_COUNT=$(grep -c '^E' "${LINT_LOG}" 2>/dev/null || true)
WARN_COUNT=$(grep -c '^W' "${LINT_LOG}" 2>/dev/null || true)

if [[ "${ERROR_COUNT}" -gt 0 ]]; then
  err "cfn-lint found ${ERROR_COUNT} error(s):"
  echo "" >&2
  grep -E '^E' -A 1 "${LINT_LOG}" >&2 || true
  echo "" >&2
  rm -f "${LINT_LOG}"
  exit 2
fi

if [[ "${WARN_COUNT}" -gt 0 ]]; then
  warn "cfn-lint found ${WARN_COUNT} warning(s) (non-fatal); review:"
  grep -E '^W' "${LINT_LOG}" | head -20 >&2 || true
fi
ok "cfn-lint passed (0 errors, ${WARN_COUNT} warnings)"
rm -f "${LINT_LOG}"

# ---------------------------------------------------------------------------
# Stage 3: cycle-check
# ---------------------------------------------------------------------------

step "Stage 3/4: cycle-check (Tarjan SCC on resource graph)..."

if [[ ! -f "${CYCLE_CHECK_TS}" ]]; then
  err "cycle-check.ts not found at ${CYCLE_CHECK_TS}"
  exit 10
fi

CYCLE_EXIT=0
(
  cd "${PROJECT_ROOT}"
  npx tsx "${CYCLE_CHECK_TS}" "${TEMPLATE_PATH}" >&2
) || CYCLE_EXIT=$?

if [[ "${CYCLE_EXIT}" -ne 0 ]]; then
  err "Cycle check FAILED (exit ${CYCLE_EXIT}). See cycles above."
  exit 3
fi

# ---------------------------------------------------------------------------
# Stage 4: cdk deploy --no-execute (AWS-side validation, no provisioning)
# ---------------------------------------------------------------------------

step "Stage 4/4: cdk deploy --no-execute (AWS changeset validation)..."

# AWS credentials must be reachable for this stage. If sts get-caller-identity
# fails, skip stage 4 with a warning - useful for CI environments that don't
# have AWS access on every PR.
if ! aws sts get-caller-identity >/dev/null 2>&1; then
  warn "AWS credentials unavailable - skipping stage 4 (changeset validation)."
  warn "Stages 1-3 passed offline. Operator must run real deploy with valid creds."
  echo "" >&2
  echo "  ============================================================" >&2
  ok "Pre-deploy validation: 3/4 stages passed (stage 4 skipped)"
  echo "  ============================================================" >&2
  exit 0
fi

NOEXEC_LOG="$(mktemp -t orbital-noexec.XXXXXX.log)"
NOEXEC_EXIT=0
(
  cd "${INFRA_DIR}"
  JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION="${JSII_SILENCE_WARNING_UNTESTED_NODE_VERSION:-1}" \
    npx cdk deploy \
      --context env="${ENV}" \
      --no-execute \
      --require-approval never
) >"${NOEXEC_LOG}" 2>&1 || NOEXEC_EXIT=$?

if [[ "${NOEXEC_EXIT}" -ne 0 ]]; then
  err "cdk deploy --no-execute FAILED (exit ${NOEXEC_EXIT})"
  echo "" >&2
  cat "${NOEXEC_LOG}" >&2
  rm -f "${NOEXEC_LOG}"
  exit 4
fi

ok "AWS changeset validation passed (no provisioning performed)"
rm -f "${NOEXEC_LOG}"

# ---------------------------------------------------------------------------
# Cleanup: delete the changeset we just created so the stack isn't left in
# REVIEW_IN_PROGRESS limbo. CDK names changesets `cdk-deploy-change-set`
# (per `cdk deploy --no-execute` docs).
# ---------------------------------------------------------------------------

step "Cleanup: removing no-execute changeset..."
CLEANUP_EXIT=0
aws cloudformation delete-change-set \
  --stack-name "${STACK_NAME}" \
  --change-set-name "cdk-deploy-change-set" \
  >/dev/null 2>&1 || CLEANUP_EXIT=$?

if [[ "${CLEANUP_EXIT}" -eq 0 ]]; then
  ok "Changeset deleted"
else
  warn "Changeset cleanup returned non-zero (often benign - stack may be new)."
  warn "Operator can run: aws cloudformation list-change-sets --stack-name ${STACK_NAME}"
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo "" >&2
echo "  ============================================================" >&2
ok "Pre-deploy validation passed (4/4 stages) for env=${ENV}"
echo "  ============================================================" >&2
exit 0
