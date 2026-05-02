#!/usr/bin/env bash
# scripts/hub-rotate-master-key.sh — Orbital Hub master key rotation.
#
# Round 7-07 — Hub Deployment + Operations
# [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops]
#
# Rotation procedure:
#   1. Generate a new 64-hex-char master key.
#   2. Record the rotation in the hub's audit log table (if Postgres is accessible).
#   3. Update ORBITAL_HUB_MASTER_KEY in the .env file.
#   4. Write the old key to a time-limited backup file (24h verification window).
#   5. Print instructions for rolling the hub service container.
#
# The old key is kept in ./secrets/hub_master_key.prev for 24h (default) so
# any in-flight operations that signed with the old key can still verify.
# After the verification window, remove hub_master_key.prev manually.
#
# Usage:
#   bash scripts/hub-rotate-master-key.sh
#
#   # Skip confirmation:
#   bash scripts/hub-rotate-master-key.sh --yes-i-know-what-i-am-doing
#
#   # Custom verification window:
#   ROTATION_VERIFICATION_HOURS=48 bash scripts/hub-rotate-master-key.sh
#
# Environment variables:
#   DATABASE_URL                   — optional; used to record audit event
#   ORBITAL_HUB_MASTER_KEY         — current master key (must be in env or .env)
#   ROTATION_VERIFICATION_HOURS    — hours old key is kept (default: 24)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
ENV_FILE="${PROJECT_ROOT}/.env"
SECRETS_DIR="${PROJECT_ROOT}/secrets"
VERIFICATION_HOURS="${ROTATION_VERIFICATION_HOURS:-24}"

# Load .env
if [[ -f "${ENV_FILE}" ]]; then
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    [[ -z "${!key:-}" ]] && export "${key}"="${value}"
  done < <(grep -v '^#' "${ENV_FILE}" | grep '=')
fi

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------
SKIP_CONFIRM=0
for arg in "$@"; do
  case "$arg" in
    --yes-i-know-what-i-am-doing) SKIP_CONFIRM=1 ;;
    *)
      echo "Unknown flag: $arg" >&2
      echo "Usage: bash scripts/hub-rotate-master-key.sh [--yes-i-know-what-i-am-doing]" >&2
      exit 1
      ;;
  esac
done

# Validate current key exists
: "${ORBITAL_HUB_MASTER_KEY:?ORBITAL_HUB_MASTER_KEY must be set in .env}"

OLD_KEY="${ORBITAL_HUB_MASTER_KEY}"

# ---------------------------------------------------------------------------
# Confirmation
# ---------------------------------------------------------------------------
if [[ "$SKIP_CONFIRM" -eq 0 ]]; then
  echo ""
  echo "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "  WARNING: Hub master key rotation."
  echo "  After rotation, YOU MUST restart the hub service."
  echo "  The old key is kept for ${VERIFICATION_HOURS}h in secrets/hub_master_key.prev"
  echo "  for verification of in-flight operations."
  echo "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo ""
  echo "  Current key fingerprint (first 8 chars): ${OLD_KEY:0:8}..."
  echo ""
  printf '  Type "rotate master key" to proceed: '
  read -r confirmation
  if [[ "$confirmation" != "rotate master key" ]]; then
    echo "Rotation cancelled."
    exit 0
  fi
  echo ""
fi

# ---------------------------------------------------------------------------
# Generate new key
# ---------------------------------------------------------------------------
NEW_KEY=$(openssl rand -hex 32)
ROTATION_TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
EXPIRY_TIMESTAMP=$(date -u -d "+${VERIFICATION_HOURS} hours" +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
  || date -u -v+${VERIFICATION_HOURS}H +"%Y-%m-%dT%H:%M:%SZ" 2>/dev/null \
  || echo "CHECK_MANUALLY")

echo "{\"event\":\"key_rotation_start\",\"old_key_prefix\":\"${OLD_KEY:0:8}\",\"timestamp\":\"${ROTATION_TIMESTAMP}\"}"

# ---------------------------------------------------------------------------
# Save old key as .prev (for verification window)
# ---------------------------------------------------------------------------
mkdir -p "${SECRETS_DIR}"
printf '%s' "${OLD_KEY}" > "${SECRETS_DIR}/hub_master_key.prev"
chmod 600 "${SECRETS_DIR}/hub_master_key.prev"
echo "{\"event\":\"old_key_saved\",\"path\":\"secrets/hub_master_key.prev\",\"expires_at\":\"${EXPIRY_TIMESTAMP}\"}"

# ---------------------------------------------------------------------------
# Write new key to secrets/hub_master_key
# ---------------------------------------------------------------------------
printf '%s' "${NEW_KEY}" > "${SECRETS_DIR}/hub_master_key"
chmod 600 "${SECRETS_DIR}/hub_master_key"
echo "{\"event\":\"new_key_written\",\"path\":\"secrets/hub_master_key\",\"key_prefix\":\"${NEW_KEY:0:8}\"}"

# ---------------------------------------------------------------------------
# Update .env file
# ---------------------------------------------------------------------------
if [[ -f "${ENV_FILE}" ]]; then
  TMP_ENV=$(mktemp)
  # Replace ORBITAL_HUB_MASTER_KEY line
  sed "s|^ORBITAL_HUB_MASTER_KEY=.*|ORBITAL_HUB_MASTER_KEY=${NEW_KEY}|" "${ENV_FILE}" > "${TMP_ENV}"
  mv "${TMP_ENV}" "${ENV_FILE}"
else
  printf 'ORBITAL_HUB_MASTER_KEY=%s\n' "${NEW_KEY}" >> "${ENV_FILE}"
fi
echo "{\"event\":\"env_updated\",\"file\":\".env\"}"

# ---------------------------------------------------------------------------
# Record rotation in audit log (best-effort — do not fail rotation if DB unreachable)
# ---------------------------------------------------------------------------
if command -v psql >/dev/null 2>&1 && [[ -n "${DATABASE_URL:-}" ]]; then
  psql "${DATABASE_URL}" --no-password -v ON_ERROR_STOP=0 -c "
    INSERT INTO audit.events (
      event_id, aggregate_id, aggregate_type, event_type,
      payload, actor, trace_id, occurred_at, schema_version
    ) VALUES (
      gen_random_uuid(),
      '${ORBITAL_HUB_TENANT_ID:-00000000-0000-0000-0000-000000000000}'::uuid,
      'hub',
      'hub.master_key_rotated',
      '{\"old_key_prefix\":\"${OLD_KEY:0:8}\",\"rotation_timestamp\":\"${ROTATION_TIMESTAMP}\",\"verification_window_hours\":${VERIFICATION_HOURS}}'::jsonb,
      '{\"type\":\"system\",\"id\":\"hub-rotate-master-key.sh\",\"tenant_id\":\"${ORBITAL_HUB_TENANT_ID:-00000000-0000-0000-0000-000000000000}\"}'::jsonb,
      'hub-key-rotation',
      NOW(),
      1
    );
  " >/dev/null 2>&1 && echo "{\"event\":\"audit_logged\",\"table\":\"audit.events\"}" \
    || echo "{\"event\":\"audit_log_skipped\",\"reason\":\"DB not reachable or events table not yet created\"}"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
echo ""
echo "  Key rotation complete."
echo ""
echo "  New key prefix : ${NEW_KEY:0:8}..."
echo "  Old key kept   : secrets/hub_master_key.prev (delete after ${EXPIRY_TIMESTAMP})"
echo ""
echo "  NEXT STEPS:"
echo "    1. Restart the hub service to pick up the new key:"
echo "       docker compose -f docker-compose.hub.yml restart orbital-hub"
echo ""
echo "    2. Verify the hub is healthy:"
echo "       curl -f https://\${ORBITAL_HOSTNAME}/health"
echo ""
echo "    3. After ${VERIFICATION_HOURS}h, remove the old key backup:"
echo "       rm secrets/hub_master_key.prev"
echo ""
