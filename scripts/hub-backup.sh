#!/usr/bin/env bash
# scripts/hub-backup.sh — Orbital Hub backup script.
#
# Round 7-07 — Hub Deployment + Operations
# [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops]
#
# What this script does:
#   1. Runs pg_dump against the hub Postgres instance.
#   2. Compresses the dump with gzip.
#   3. Encrypts the compressed dump with AES-256-CBC using the hub master key.
#   4. Saves to a local directory (and optionally uploads to S3/R2).
#   5. Logs the backup metadata to stdout in structured JSON.
#
# Usage:
#   bash scripts/hub-backup.sh
#
#   # With S3/R2 upload:
#   BACKUP_S3_BUCKET=my-bucket BACKUP_S3_PREFIX=orbital-backups/ bash scripts/hub-backup.sh
#
# Environment variables:
#   DATABASE_URL            — Postgres connection string (required)
#   ORBITAL_HUB_MASTER_KEY  — 64-hex-char key for AES encryption (required)
#   BACKUP_DIR              — local directory to save backups (default: ./backups)
#   BACKUP_S3_BUCKET        — S3/R2 bucket name (optional)
#   BACKUP_S3_PREFIX        — S3/R2 key prefix (optional, default: orbital-backups/)
#   BACKUP_S3_ENDPOINT      — Custom S3 endpoint for Cloudflare R2 (optional)
#   AWS_ACCESS_KEY_ID       — AWS/R2 access key (optional, for S3 upload)
#   AWS_SECRET_ACCESS_KEY   — AWS/R2 secret key (optional, for S3 upload)
#   BACKUP_RETENTION_DAYS   — How many days of local backups to keep (default: 30)
#
# Prerequisites:
#   - pg_dump      (postgresql-client package)
#   - openssl      (encryption)
#   - gzip         (compression)
#   - aws CLI      (optional, for S3/R2 upload)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"

# Load .env if present and vars not already set
if [[ -f "${PROJECT_ROOT}/.env" ]]; then
  # Only export vars not already in environment
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ || -z "$key" ]] && continue
    # Strip quotes
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    [[ -z "${!key:-}" ]] && export "${key}"="${value}"
  done < <(grep -v '^#' "${PROJECT_ROOT}/.env" | grep '=')
fi

# ---------------------------------------------------------------------------
# Validate required vars
# ---------------------------------------------------------------------------
: "${DATABASE_URL:?DATABASE_URL must be set (Postgres connection string)}"
: "${ORBITAL_HUB_MASTER_KEY:?ORBITAL_HUB_MASTER_KEY must be set}"

BACKUP_DIR="${BACKUP_DIR:-${PROJECT_ROOT}/backups}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-orbital-backups/}"
BACKUP_RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"
TIMESTAMP=$(date -u +"%Y%m%dT%H%M%SZ")
BACKUP_FILENAME="orbital-hub-backup-${TIMESTAMP}.sql.gz.enc"
BACKUP_PATH="${BACKUP_DIR}/${BACKUP_FILENAME}"

mkdir -p "${BACKUP_DIR}"

# ---------------------------------------------------------------------------
# Derive encryption key from master key
# Derive a 32-byte AES key from the master key using HKDF-SHA256 via openssl
# (openssl does not have HKDF directly in CLI; use PBKDF2 with high iterations
# against a fixed salt tagged "orbital-backup" for domain separation)
# ---------------------------------------------------------------------------
derive_aes_key() {
  local master_key="$1"
  printf '%s' "${master_key}:orbital-backup-aes-key" \
    | openssl dgst -sha256 -binary \
    | xxd -p -c 256 \
    | head -c 64
}

AES_KEY=$(derive_aes_key "${ORBITAL_HUB_MASTER_KEY}")

# ---------------------------------------------------------------------------
# Step 1: pg_dump → gzip → AES-256-CBC encrypt → file
# ---------------------------------------------------------------------------
echo "{\"event\":\"backup_start\",\"filename\":\"${BACKUP_FILENAME}\",\"timestamp\":\"${TIMESTAMP}\"}"

# pg_dump writes to stdout; pipe through gzip then encrypt
pg_dump \
  --no-password \
  --format=plain \
  --no-owner \
  --no-acl \
  "${DATABASE_URL}" \
  | gzip -c \
  | openssl enc -aes-256-cbc \
      -pbkdf2 \
      -iter 100000 \
      -pass "pass:${AES_KEY}" \
      -out "${BACKUP_PATH}"

BACKUP_SIZE=$(wc -c < "${BACKUP_PATH}")

echo "{\"event\":\"backup_written\",\"path\":\"${BACKUP_PATH}\",\"size_bytes\":${BACKUP_SIZE},\"timestamp\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"

# ---------------------------------------------------------------------------
# Step 2: Optional S3/R2 upload
# ---------------------------------------------------------------------------
if [[ -n "${BACKUP_S3_BUCKET}" ]]; then
  S3_KEY="${BACKUP_S3_PREFIX}${BACKUP_FILENAME}"

  echo "{\"event\":\"upload_start\",\"bucket\":\"${BACKUP_S3_BUCKET}\",\"key\":\"${S3_KEY}\"}"

  AWS_ARGS=()
  if [[ -n "${BACKUP_S3_ENDPOINT:-}" ]]; then
    AWS_ARGS+=("--endpoint-url" "${BACKUP_S3_ENDPOINT}")
  fi

  aws "${AWS_ARGS[@]}" s3 cp \
    "${BACKUP_PATH}" \
    "s3://${BACKUP_S3_BUCKET}/${S3_KEY}" \
    --sse AES256 \
    --storage-class STANDARD_IA

  echo "{\"event\":\"upload_complete\",\"bucket\":\"${BACKUP_S3_BUCKET}\",\"key\":\"${S3_KEY}\"}"
fi

# ---------------------------------------------------------------------------
# Step 3: Prune local backups older than BACKUP_RETENTION_DAYS
# ---------------------------------------------------------------------------
if command -v find >/dev/null 2>&1; then
  DELETED=$(find "${BACKUP_DIR}" -name 'orbital-hub-backup-*.sql.gz.enc' \
    -mtime "+${BACKUP_RETENTION_DAYS}" -print -delete 2>/dev/null | wc -l)
  if [[ "$DELETED" -gt 0 ]]; then
    echo "{\"event\":\"pruned_old_backups\",\"count\":${DELETED},\"retention_days\":${BACKUP_RETENTION_DAYS}}"
  fi
fi

echo "{\"event\":\"backup_complete\",\"filename\":\"${BACKUP_FILENAME}\",\"size_bytes\":${BACKUP_SIZE},\"timestamp\":\"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\"}"
