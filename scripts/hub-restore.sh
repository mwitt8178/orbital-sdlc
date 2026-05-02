#!/usr/bin/env bash
# scripts/hub-restore.sh — Orbital Hub restore from encrypted backup.
#
# Round 7-07 — Hub Deployment + Operations
# [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops]
#
# What this script does:
#   1. Prompts for explicit confirmation (unless --yes-i-know-what-i-am-doing).
#   2. Decrypts the backup file using the hub master key.
#   3. Decompresses and pipes into psql against the target DATABASE_URL.
#   4. Logs progress to stdout in structured JSON.
#
# Usage:
#   bash scripts/hub-restore.sh --backup=./backups/orbital-hub-backup-20250101T120000Z.sql.gz.enc
#
#   # Skip interactive confirmation (use in automation with care):
#   bash scripts/hub-restore.sh --backup=<file> --yes-i-know-what-i-am-doing
#
# Environment variables:
#   DATABASE_URL            — Target Postgres connection string (required)
#   ORBITAL_HUB_MASTER_KEY  — 64-hex-char key matching the backup encryption (required)
#
# Prerequisites:
#   - psql          (postgresql-client package)
#   - openssl       (decryption)
#   - gzip          (decompression)

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

# ---------------------------------------------------------------------------
# Parse flags
# ---------------------------------------------------------------------------
BACKUP_FILE=""
SKIP_CONFIRM=0

for arg in "$@"; do
  case "$arg" in
    --backup=*)            BACKUP_FILE="${arg#*=}" ;;
    --yes-i-know-what-i-am-doing) SKIP_CONFIRM=1 ;;
    *)
      echo "Unknown flag: $arg" >&2
      echo "Usage: bash scripts/hub-restore.sh --backup=<path> [--yes-i-know-what-i-am-doing]" >&2
      exit 1
      ;;
  esac
done

if [[ -z "$BACKUP_FILE" ]]; then
  echo "ERROR: --backup=<path> is required" >&2
  exit 1
fi

if [[ ! -f "$BACKUP_FILE" ]]; then
  echo "ERROR: Backup file not found: ${BACKUP_FILE}" >&2
  exit 1
fi

# ---------------------------------------------------------------------------
# Validate required vars
# ---------------------------------------------------------------------------
: "${DATABASE_URL:?DATABASE_URL must be set}"
: "${ORBITAL_HUB_MASTER_KEY:?ORBITAL_HUB_MASTER_KEY must be set}"

BACKUP_SIZE=$(wc -c < "${BACKUP_FILE}")
BACKUP_BASENAME=$(basename "${BACKUP_FILE}")

# ---------------------------------------------------------------------------
# Confirmation guard
# ---------------------------------------------------------------------------
if [[ "$SKIP_CONFIRM" -eq 0 ]]; then
  echo ""
  echo "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo "  WARNING: This will RESTORE the database from a backup."
  echo "  All current data will be REPLACED."
  echo "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!"
  echo ""
  echo "  Backup file : ${BACKUP_BASENAME}"
  echo "  File size   : ${BACKUP_SIZE} bytes"
  echo "  Target DB   : ${DATABASE_URL}"
  echo ""
  printf '  Type "yes, restore" to proceed: '
  read -r confirmation
  if [[ "$confirmation" != "yes, restore" ]]; then
    echo "Restore cancelled."
    exit 0
  fi
  echo ""
fi

# ---------------------------------------------------------------------------
# Derive AES key (same as backup.sh)
# ---------------------------------------------------------------------------
derive_aes_key() {
  local master_key="$1"
  printf '%s' "${master_key}:orbital-backup-aes-key" \
    | openssl dgst -sha256 -binary \
    | xxd -p -c 256 \
    | head -c 64
}

AES_KEY=$(derive_aes_key "${ORBITAL_HUB_MASTER_KEY}")

TIMESTAMP=$(date -u +"%Y-%m-%dT%H:%M:%SZ")
echo "{\"event\":\"restore_start\",\"backup\":\"${BACKUP_BASENAME}\",\"timestamp\":\"${TIMESTAMP}\"}"

# ---------------------------------------------------------------------------
# Decrypt → decompress → restore
# ---------------------------------------------------------------------------
openssl enc -aes-256-cbc \
    -d \
    -pbkdf2 \
    -iter 100000 \
    -pass "pass:${AES_KEY}" \
    -in "${BACKUP_FILE}" \
  | gunzip -c \
  | psql "${DATABASE_URL}" --no-password -v ON_ERROR_STOP=1

echo "{\"event\":\"restore_complete\",\"backup\":\"${BACKUP_BASENAME}\",\"timestamp\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"
echo ""
echo "  Restore complete. Verify data with:"
echo "    psql \"\${DATABASE_URL}\" -c 'SELECT count(*) FROM events;'"
echo ""
