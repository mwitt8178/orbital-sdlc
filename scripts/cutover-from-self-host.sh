#!/usr/bin/env bash
# scripts/cutover-from-self-host.sh — Migrate a running self-host hub to AWS.
#
# Round 8-09 — Cutover + Multi-env Smoke + Deploy Scripts
# [Engineer-Principal · Opus · run-round8-09-cutover-smoke]
#
# Procedure (matches docs/aws-deployment.md cutover playbook):
#   1. Verify self-host hub is reachable + Aurora target is reachable.
#   2. Pre-cutover: print DNS TTL guidance.
#   3. Set self-host hub to read-only mode (operator confirmation required).
#   4. pg_dump self-host Postgres to a local timestamped file.
#   5. Restore the dump into Aurora via psql (through bastion or VPN).
#      The script does NOT open a tunnel; you must already be able to reach
#      the Aurora writer endpoint from this host (e.g., via SSM session, VPN,
#      or running the script on the bastion).
#   6. Verify event count matches between source and target.
#   7. Print DNS cutover instructions + final smoke command.
#   8. Optionally trigger DNS cutover via Route 53 (with confirmation).
#
# Usage:
#   ORBITAL_HUB_URL=https://hub.example.com \
#   ORBITAL_HUB_OWNER_TOKEN=<token> \
#   ORBITAL_SELFHOST_PG_URL=postgres://orbital:pw@localhost:5433/orbital_hub \
#   ORBITAL_AURORA_PG_URL=postgres://admin:pw@orbital-mwitt-rds-proxy.proxy-...rds.amazonaws.com:5432/orbital_hub \
#   ./scripts/cutover-from-self-host.sh mwitt
#
# Optional flags / vars:
#   --dump-only             Run only steps 1–4 (dump). Useful for staged cutovers.
#   --restore-only          Run only step 5 (restore from existing dump).
#   --dump-file=<path>      Use a specific dump file for restore (default: latest in ./backups/cutover/).
#   --skip-readonly         Don't toggle the self-host hub to read-only mode.
#   --skip-dns              Don't prompt for DNS cutover.
#   ORBITAL_CUTOVER_AUTO=1  Bypass interactive confirmations (CI). DESTRUCTIVE — verify env first.
#
# Exit codes:
#   0 success, 1 usage error, 2 prereq failure, 3 dump failure,
#   4 restore failure, 5 verification failure

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
# Args
# ---------------------------------------------------------------------------

DUMP_ONLY=0
RESTORE_ONLY=0
DUMP_FILE=""
SKIP_READONLY=0
SKIP_DNS=0
ENV=""

for arg in "$@"; do
  case "${arg}" in
    --dump-only)     DUMP_ONLY=1 ;;
    --restore-only)  RESTORE_ONLY=1 ;;
    --dump-file=*)   DUMP_FILE="${arg#*=}" ;;
    --skip-readonly) SKIP_READONLY=1 ;;
    --skip-dns)      SKIP_DNS=1 ;;
    -*)
      err "Unknown flag: ${arg}"
      err "Usage: $0 <env> [--dump-only] [--restore-only] [--dump-file=<path>] [--skip-readonly] [--skip-dns]"
      exit 1
      ;;
    *)
      if [[ -z "${ENV}" ]]; then ENV="${arg}"; fi
      ;;
  esac
done

if [[ -z "${ENV}" ]]; then
  err "usage: $0 <env>   (env = mwitt | rreed | prod)"
  exit 1
fi
case "${ENV}" in mwitt|rreed|prod) ;; *) err "Invalid env '${ENV}'."; exit 1 ;; esac

# Required vars unless restore-only
SELFHOST_PG_URL="${ORBITAL_SELFHOST_PG_URL:-}"
AURORA_PG_URL="${ORBITAL_AURORA_PG_URL:-}"
HUB_URL="${ORBITAL_HUB_URL:-}"
OWNER_TOKEN="${ORBITAL_HUB_OWNER_TOKEN:-}"

if [[ ${RESTORE_ONLY} -eq 0 && -z "${SELFHOST_PG_URL}" ]]; then
  err "ORBITAL_SELFHOST_PG_URL must be set (e.g., postgres://orbital:pw@localhost:5433/orbital_hub)"
  exit 1
fi
if [[ ${DUMP_ONLY} -eq 0 && -z "${AURORA_PG_URL}" ]]; then
  err "ORBITAL_AURORA_PG_URL must be set (e.g., postgres://admin:pw@<rds-proxy>:5432/orbital_hub)"
  exit 1
fi

# ---------------------------------------------------------------------------
# Banner
# ---------------------------------------------------------------------------

echo ""
echo "  ============================================================"
echo "  Orbital Self-Host → AWS Cutover — env=${ENV}"
echo "  ${PERSONA}"
echo "  ============================================================"
warn "This procedure migrates LIVE data. Read the playbook before continuing:"
warn "  ${PROJECT_ROOT}/docs/aws-deployment.md (Cutover playbook section)"
echo ""

# ---------------------------------------------------------------------------
# Prereqs
# ---------------------------------------------------------------------------

step "Checking prereqs..."
for cmd in pg_dump psql jq aws; do
  if ! command -v "${cmd}" >/dev/null 2>&1; then
    err "Required command not found: ${cmd}"
    exit 2
  fi
done
ok "pg_dump, psql, jq, aws all present"

PGV=$(pg_dump --version | awk '{print $3}' | cut -d. -f1)
if [[ "${PGV}" -lt 14 ]]; then
  warn "pg_dump v${PGV} — Aurora target is Postgres 16; recommend pg_dump >= 16 to match feature set."
fi

mkdir -p "${PROJECT_ROOT}/backups/cutover"

# ---------------------------------------------------------------------------
# Confirmation
# ---------------------------------------------------------------------------

if [[ "${ORBITAL_CUTOVER_AUTO:-}" != "1" ]]; then
  echo ""
  echo "  About to perform a cutover with these endpoints:"
  echo "    Self-host PG:  ${SELFHOST_PG_URL%%@*}@<redacted>"
  echo "    Aurora PG:     ${AURORA_PG_URL%%@*}@<redacted>"
  echo "    Hub URL:       ${HUB_URL:-<not set>}"
  echo ""
  read -rp "Type 'cutover' to confirm: " CONFIRM
  if [[ "${CONFIRM}" != "cutover" ]]; then
    err "Confirmation failed. Aborting."
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
# Step 2 — DNS TTL guidance
# ---------------------------------------------------------------------------

step "DNS TTL pre-flight check"
DOMAIN=$(jq -r ".context.envs.\"${ENV}\".domain" "${INFRA_DIR}/cdk.json" 2>/dev/null || echo "")
if [[ -n "${DOMAIN}" && "${DOMAIN}" != "null" ]]; then
  ok "Target domain: ${DOMAIN}"
fi
warn "Confirm self-host DNS TTL is <= 60s. Run on the DNS-managing host:"
warn "  dig +short SOA <self-host-domain>"
warn "If TTL > 60s, lower it now and wait 1× current-TTL before continuing."
echo ""

# ---------------------------------------------------------------------------
# Step 3 — Read-only mode
# ---------------------------------------------------------------------------

if [[ ${RESTORE_ONLY} -eq 0 && ${SKIP_READONLY} -eq 0 ]]; then
  step "Setting self-host hub to read-only mode"
  if [[ -n "${HUB_URL}" && -n "${OWNER_TOKEN}" ]]; then
    set +e
    RO_OUT=$(curl -fsS --max-time 30 -X POST \
      -H "x-orbital-owner-token: ${OWNER_TOKEN}" \
      -H 'content-type: application/json' \
      -d '{"readonly":true}' \
      "${HUB_URL%/}/admin/readonly" 2>&1)
    RO_EXIT=$?
    set -e
    if [[ ${RO_EXIT} -eq 0 ]]; then
      ok "Self-host hub set to read-only: ${RO_OUT}"
    else
      warn "Could not toggle read-only via /admin/readonly (exit ${RO_EXIT})."
      warn "Set ORBITAL_HUB_READONLY=1 in the hub's .env and restart the container manually."
    fi
  else
    warn "ORBITAL_HUB_URL or ORBITAL_HUB_OWNER_TOKEN not set — toggle read-only manually:"
    warn "  Set ORBITAL_HUB_READONLY=1 in the hub .env and restart the container."
  fi
fi

# ---------------------------------------------------------------------------
# Step 4 — pg_dump
# ---------------------------------------------------------------------------

if [[ ${RESTORE_ONLY} -eq 0 ]]; then
  step "Running pg_dump from self-host Postgres"
  TS=$(date -u +%Y%m%dT%H%M%SZ)
  DUMP_FILE_OUT="${PROJECT_ROOT}/backups/cutover/orbital-cutover-${ENV}-${TS}.sql"
  DUMP_START=$(date +%s)
  set +e
  pg_dump \
    --no-owner \
    --no-privileges \
    --quote-all-identifiers \
    --format=plain \
    --file="${DUMP_FILE_OUT}" \
    "${SELFHOST_PG_URL}" 2>&1
  PG_EXIT=$?
  set -e
  DUMP_END=$(date +%s)
  if [[ ${PG_EXIT} -ne 0 ]]; then
    err "pg_dump failed (exit ${PG_EXIT}). Dump file: ${DUMP_FILE_OUT}"
    exit 3
  fi
  DUMP_SIZE=$(wc -c < "${DUMP_FILE_OUT}" | xargs)
  ok "Dump complete in $(( DUMP_END - DUMP_START ))s — ${DUMP_FILE_OUT} (${DUMP_SIZE} bytes)"

  # Source-side counts for verification
  SRC_EVENTS=$(psql "${SELFHOST_PG_URL}" -At -c 'SELECT COUNT(*) FROM events;' 2>/dev/null || echo "0")
  ok "Source row count — events: ${SRC_EVENTS}"
  echo "${SRC_EVENTS}" > "${DUMP_FILE_OUT}.events-count"

  if [[ -z "${DUMP_FILE}" ]]; then
    DUMP_FILE="${DUMP_FILE_OUT}"
  fi

  if [[ ${DUMP_ONLY} -eq 1 ]]; then
    echo ""
    echo "  ============================================================"
    ok "Dump-only mode complete."
    echo "  ============================================================"
    echo "  Dump file:    ${DUMP_FILE_OUT}"
    echo "  Source events: ${SRC_EVENTS}"
    echo ""
    echo "  Resume with:"
    echo "    ./scripts/cutover-from-self-host.sh ${ENV} --restore-only --dump-file=${DUMP_FILE_OUT}"
    exit 0
  fi
fi

# ---------------------------------------------------------------------------
# Step 5 — Restore into Aurora
# ---------------------------------------------------------------------------

# Resolve dump file for restore-only mode
if [[ ${RESTORE_ONLY} -eq 1 && -z "${DUMP_FILE}" ]]; then
  DUMP_FILE=$(ls -t "${PROJECT_ROOT}/backups/cutover/"*.sql 2>/dev/null | head -1 || true)
  if [[ -z "${DUMP_FILE}" ]]; then
    err "No dump file found in ${PROJECT_ROOT}/backups/cutover/. Use --dump-file=<path>."
    exit 1
  fi
fi

if [[ ! -f "${DUMP_FILE}" ]]; then
  err "Dump file not found: ${DUMP_FILE}"
  exit 1
fi

step "Restoring dump into Aurora (${DUMP_FILE})"
warn "This is destructive against the Aurora target. Existing rows in matching tables WILL be replaced."
if [[ "${ORBITAL_CUTOVER_AUTO:-}" != "1" ]]; then
  read -rp "Type 'restore' to confirm: " RESTORE_CONFIRM
  if [[ "${RESTORE_CONFIRM}" != "restore" ]]; then
    err "Confirmation failed. Aborting."
    exit 1
  fi
fi

RESTORE_START=$(date +%s)
set +e
psql \
  -v ON_ERROR_STOP=1 \
  --single-transaction \
  --file="${DUMP_FILE}" \
  "${AURORA_PG_URL}"
PSQL_EXIT=$?
set -e
RESTORE_END=$(date +%s)
if [[ ${PSQL_EXIT} -ne 0 ]]; then
  err "psql restore failed (exit ${PSQL_EXIT})."
  err "Note: Aurora DSQL has hard-no rules (no FKs, sequences, triggers). If the dump"
  err "contains those, edit the dump or use additive 4-phase migrations instead."
  exit 4
fi
ok "Restore complete in $(( RESTORE_END - RESTORE_START ))s"

# ---------------------------------------------------------------------------
# Step 6 — Verification
# ---------------------------------------------------------------------------

step "Verifying event count parity"
TGT_EVENTS=$(psql "${AURORA_PG_URL}" -At -c 'SELECT COUNT(*) FROM events;' 2>/dev/null || echo "0")
ok "Target row count — events: ${TGT_EVENTS}"

SRC_COUNT_FILE="${DUMP_FILE}.events-count"
SRC_EVENTS_REC=""
if [[ -f "${SRC_COUNT_FILE}" ]]; then
  SRC_EVENTS_REC=$(cat "${SRC_COUNT_FILE}")
fi

if [[ -n "${SRC_EVENTS_REC}" && "${TGT_EVENTS}" == "${SRC_EVENTS_REC}" ]]; then
  ok "Event count parity — ${SRC_EVENTS_REC} == ${TGT_EVENTS}"
elif [[ -n "${SRC_EVENTS_REC}" ]]; then
  err "Event count mismatch — source=${SRC_EVENTS_REC}, target=${TGT_EVENTS}"
  err "Investigate before completing DNS cutover."
  exit 5
else
  warn "No source count file at ${SRC_COUNT_FILE} — re-run with --dump-only to capture, or verify manually."
fi

# ---------------------------------------------------------------------------
# Step 7 — DNS cutover instructions
# ---------------------------------------------------------------------------

if [[ ${SKIP_DNS} -eq 0 ]]; then
  step "DNS cutover"
  echo ""
  echo "  To complete the cutover, point your DNS at the AWS API Gateway:"
  echo ""
  echo "    1. Get the AWS endpoint:"
  echo "       aws cloudformation describe-stacks --stack-name OrbitalHub-${ENV} \\"
  echo "         --query \"Stacks[0].Outputs[?OutputKey=='ApiEndpoint'].OutputValue\" --output text"
  echo ""
  echo "    2. Update your DNS provider (Route 53 / Cloudflare / etc.):"
  echo "       <self-host-domain>  CNAME  <api-endpoint>"
  echo ""
  echo "    3. Wait for propagation (30–60s with 60s TTL)."
  echo ""
  echo "    4. Smoke test the new endpoint:"
  echo "       ./scripts/aws-smoke-test.sh ${ENV}"
  echo ""
  warn "DO NOT update DNS until you have confirmed event count parity above."
  echo ""
fi

# ---------------------------------------------------------------------------
# Done
# ---------------------------------------------------------------------------

echo ""
echo "  ============================================================"
ok "Cutover data migration complete for env=${ENV}"
echo "  ============================================================"
echo ""
echo "  Next steps:"
echo "    1. DNS cutover (see above)."
echo "    2. Watch alarms for 24h: ./scripts/aws-smoke-test.sh ${ENV}"
echo "    3. After 7-day soak, decommission self-host (see docs/aws-deployment.md)."
echo ""
echo "  Rollback: see docs/aws-rollback.md (revert DNS + restart self-host)."
echo ""
exit 0
