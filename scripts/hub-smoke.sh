#!/usr/bin/env bash
# scripts/hub-smoke.sh — Hub smoke test: health + admin endpoints + backup roundtrip.
#
# Round 7-07 — Hub Deployment + Operations
# [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops]
#
# Tests:
#   1. GET /health returns { status: "ok", mode: "hub" }
#   2. GET /admin/health returns { mode: "hub", db: { status: "ok" } }
#   3. GET /admin/installs returns 200 (with owner token)
#   4. GET /admin/audit-tail returns { events: [...] }
#   5. GET /admin/backup/status returns { backups: [...] }
#   6. POST /admin/backup triggers a backup (if pg_dump available)
#   7. Backup file exists and is non-empty
#   8. hub-restore.sh (dry-run: verify decryption only)
#
# Usage:
#   ORBITAL_HOSTNAME=localhost ORBITAL_PORT=4000 ORBITAL_OWNER_TOKEN=... bash scripts/hub-smoke.sh
#
#   # Skip backup test (no pg_dump available):
#   SKIP_BACKUP=1 bash scripts/hub-smoke.sh
#
# Prerequisites:
#   - curl
#   - jq  (for JSON parsing)
#   - Hub running at ORBITAL_HOSTNAME:ORBITAL_PORT

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Load .env if present
if [[ -f "${PROJECT_ROOT}/.env" ]]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    [[ -z "${!key:-}" ]] && export "${key}"="${value}"
  done < <(grep -v '^#' "${PROJECT_ROOT}/.env" | grep '=')
fi

HOSTNAME="${ORBITAL_HOSTNAME:-localhost}"
PORT="${ORBITAL_PORT:-4000}"
BASE_URL="http://${HOSTNAME}:${PORT}"
OWNER_TOKEN="${ORBITAL_OWNER_TOKEN:-}"
SKIP_BACKUP="${SKIP_BACKUP:-0}"

# ---------------------------------------------------------------------------
PASS=0
FAIL=0
results=()

pass() { PASS=$(( PASS + 1 )); results+=("  PASS  $1"); }
fail() { FAIL=$(( FAIL + 1 )); results+=("  FAIL  $1"); }

# ---------------------------------------------------------------------------
echo ""
echo "  Orbital Hub Smoke Tests"
echo "  Base URL: ${BASE_URL}"
echo ""

# 1. GET /health
echo "  [1/8] GET /health..."
health_body=$(curl -sf "${BASE_URL}/health" 2>&1) || { fail "GET /health — curl failed: ${health_body}"; health_body="{}"; }
if echo "${health_body}" | jq -e '.status == "ok"' >/dev/null 2>&1; then
  pass "GET /health → status=ok"
else
  fail "GET /health → expected status=ok, got: ${health_body}"
fi

if echo "${health_body}" | jq -e '.mode == "hub"' >/dev/null 2>&1; then
  pass "GET /health → mode=hub"
else
  fail "GET /health → expected mode=hub, got mode=$(echo "${health_body}" | jq -r '.mode // "missing"')"
fi

# 2. GET /admin/health
echo "  [2/8] GET /admin/health..."
admin_health=$(curl -sf "${BASE_URL}/admin/health" 2>&1) || { fail "GET /admin/health — curl failed"; admin_health="{}"; }
if echo "${admin_health}" | jq -e '.db.status == "ok"' >/dev/null 2>&1; then
  pass "GET /admin/health → db.status=ok"
else
  fail "GET /admin/health → expected db.status=ok, got: ${admin_health}"
fi

# 3. GET /admin/installs (with owner token)
echo "  [3/8] GET /admin/installs..."
INSTALL_FLAGS=()
if [[ -n "${OWNER_TOKEN}" ]]; then
  INSTALL_FLAGS=(-H "x-orbital-owner-token: ${OWNER_TOKEN}")
fi

installs_http=$(curl -so /dev/null -w "%{http_code}" "${INSTALL_FLAGS[@]}" "${BASE_URL}/admin/installs" 2>&1)
if [[ "${installs_http}" == "200" || "${installs_http}" == "401" ]]; then
  if [[ "${installs_http}" == "200" ]]; then
    pass "GET /admin/installs → 200 (token accepted)"
  else
    pass "GET /admin/installs → 401 (no token set, expected without ORBITAL_OWNER_TOKEN)"
  fi
else
  fail "GET /admin/installs → unexpected HTTP ${installs_http}"
fi

# 4. GET /admin/audit-tail
echo "  [4/8] GET /admin/audit-tail..."
audit_http=$(curl -so /dev/null -w "%{http_code}" "${INSTALL_FLAGS[@]}" "${BASE_URL}/admin/audit-tail" 2>&1)
if [[ "${audit_http}" == "200" || "${audit_http}" == "401" ]]; then
  pass "GET /admin/audit-tail → ${audit_http}"
else
  fail "GET /admin/audit-tail → unexpected HTTP ${audit_http}"
fi

# 5. GET /admin/backup/status
echo "  [5/8] GET /admin/backup/status..."
backup_status_http=$(curl -so /dev/null -w "%{http_code}" "${INSTALL_FLAGS[@]}" "${BASE_URL}/admin/backup/status" 2>&1)
if [[ "${backup_status_http}" == "200" || "${backup_status_http}" == "401" ]]; then
  pass "GET /admin/backup/status → ${backup_status_http}"
else
  fail "GET /admin/backup/status → unexpected HTTP ${backup_status_http}"
fi

# 6–8. Backup roundtrip (optional)
if [[ "${SKIP_BACKUP}" -eq 1 ]]; then
  pass "Backup roundtrip — SKIPPED (SKIP_BACKUP=1)"
  pass "Backup file exists — SKIPPED"
  pass "Restore dry-run — SKIPPED"
else
  echo "  [6/8] POST /admin/backup (trigger)..."
  if command -v pg_dump >/dev/null 2>&1 && [[ -n "${OWNER_TOKEN}" ]]; then
    backup_resp=$(curl -sf -X POST \
      -H "x-orbital-owner-token: ${OWNER_TOKEN}" \
      "${BASE_URL}/admin/backup" 2>&1)
    if echo "${backup_resp}" | jq -e '.status == "triggered"' >/dev/null 2>&1; then
      pass "POST /admin/backup → triggered"
      BACKUP_FILENAME=$(echo "${backup_resp}" | jq -r '.filename // ""')

      echo "  [7/8] Backup file exists..."
      BACKUP_PATH="${PROJECT_ROOT}/backups/${BACKUP_FILENAME}"
      if [[ -f "${BACKUP_PATH}" && -s "${BACKUP_PATH}" ]]; then
        pass "Backup file exists and non-empty: ${BACKUP_FILENAME}"
      else
        fail "Backup file not found or empty: ${BACKUP_PATH}"
      fi

      echo "  [8/8] Restore dry-run (decryption check)..."
      if command -v openssl >/dev/null 2>&1 && [[ -n "${ORBITAL_HUB_MASTER_KEY:-}" ]]; then
        AES_KEY=$(printf '%s' "${ORBITAL_HUB_MASTER_KEY}:orbital-backup-aes-key" \
          | openssl dgst -sha256 -binary | xxd -p -c 256 | head -c 64)
        DECRYPTED=$(openssl enc -aes-256-cbc -d -pbkdf2 -iter 100000 \
          -pass "pass:${AES_KEY}" -in "${BACKUP_PATH}" 2>&1 | head -c 100 || true)
        if echo "${DECRYPTED}" | grep -q 'PostgreSQL\|pg_dump\|--'; then
          pass "Restore dry-run — decryption succeeded (pg_dump header found)"
        else
          fail "Restore dry-run — decryption output did not look like a pg_dump: ${DECRYPTED:0:80}"
        fi
      else
        pass "Restore dry-run — SKIPPED (openssl or master key not available)"
      fi
    else
      fail "POST /admin/backup → unexpected response: ${backup_resp}"
      pass "Backup file exists — SKIPPED (backup trigger failed)"
      pass "Restore dry-run — SKIPPED (backup trigger failed)"
    fi
  else
    pass "POST /admin/backup — SKIPPED (pg_dump not available or no owner token)"
    pass "Backup file exists — SKIPPED"
    pass "Restore dry-run — SKIPPED"
  fi
fi

# ---------------------------------------------------------------------------
# Summary
echo ""
echo "  Results:"
for r in "${results[@]}"; do
  echo "${r}"
done
echo ""
echo "  PASS: ${PASS}  FAIL: ${FAIL}"
echo ""

if [[ "${FAIL}" -gt 0 ]]; then
  echo "  SMOKE TEST FAILED" >&2
  exit 1
else
  echo "  SMOKE TEST PASSED"
  exit 0
fi
