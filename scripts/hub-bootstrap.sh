#!/usr/bin/env bash
# scripts/hub-bootstrap.sh — Orbital Hub first-run bootstrap.
#
# Round 7-07 — Hub Deployment + Operations (extends Round 7-01 scaffold)
# [Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops]
#
# What this script does:
#   1. Generates a 64-hex-char hub master key via openssl rand.
#   2. Generates a secure Postgres password.
#   3. Writes a .env file (or appends to existing) with the required vars.
#   4. Creates the ./nginx/certs/ directory with a self-signed TLS cert if
#      no cert is already present (production operators should replace this
#      with a CA-signed or Let's Encrypt cert before going live).
#   5. Creates ./secrets/hub_master_key for Docker secrets mount.
#   6. Starts hub-postgres, waits for it to be ready, runs Drizzle migrations.
#   7. Creates the default tenant row via psql.
#   8. Generates a single-use JWT owner-invite token (HS256, 24h TTL).
#   9. Prints the invite URL and connection details.
#
# Usage:
#   ORBITAL_HOSTNAME=orbital.team.dev bash scripts/hub-bootstrap.sh
#
# Flags:
#   --apply-db           Run migrations + create default tenant (requires Docker).
#   --tenant-id=<uuid>   Use a specific tenant UUID instead of generating one.
#   --quiet              Suppress decorative output; print only the env block.
#   --skip-tls           Skip self-signed cert generation (you'll supply your own).
#   --skip-docker        Skip Docker compose operations (useful in CI).
#
# Prerequisites:
#   - openssl    (key + cert generation)
#   - uuidgen    (macOS) or /proc/sys/kernel/random/uuid (Linux)
#   - docker compose  (for --apply-db)
#   - psql       (for --apply-db, comes with PostgreSQL client)
#
# Environment variables read:
#   ORBITAL_HOSTNAME   — public hostname (used in invite URL + TLS SAN)
#                        Defaults to 'localhost'.

set -euo pipefail

# ---------------------------------------------------------------------------
# Defaults + flag parsing
# ---------------------------------------------------------------------------
APPLY_DB=0
QUIET=0
SKIP_TLS=0
SKIP_DOCKER=0
TENANT_ID_OVERRIDE=""
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
HOSTNAME="${ORBITAL_HOSTNAME:-localhost}"
ENV_FILE="${PROJECT_ROOT}/.env"

for arg in "$@"; do
  case "$arg" in
    --apply-db)    APPLY_DB=1 ;;
    --quiet)       QUIET=1 ;;
    --skip-tls)    SKIP_TLS=1 ;;
    --skip-docker) SKIP_DOCKER=1 ;;
    --tenant-id=*) TENANT_ID_OVERRIDE="${arg#*=}" ;;
    *)
      echo "Unknown flag: $arg" >&2
      echo "Usage: bash scripts/hub-bootstrap.sh [--apply-db] [--quiet] [--skip-tls] [--skip-docker] [--tenant-id=<uuid>]" >&2
      exit 1
      ;;
  esac
done

# ---------------------------------------------------------------------------
# Helper: print step header
# ---------------------------------------------------------------------------
step() {
  if [[ "$QUIET" -eq 0 ]]; then
    printf '\n  \033[1;34m=>\033[0m %s\n' "$*"
  fi
}

ok() {
  if [[ "$QUIET" -eq 0 ]]; then
    printf '     \033[1;32m✓\033[0m %s\n' "$*"
  fi
}

warn() {
  printf '     \033[1;33m!\033[0m %s\n' "$*" >&2
}

# ---------------------------------------------------------------------------
# Helper: generate UUID (portable)
# ---------------------------------------------------------------------------
gen_uuid() {
  if command -v uuidgen >/dev/null 2>&1; then
    uuidgen | tr '[:upper:]' '[:lower:]'
  elif [[ -f /proc/sys/kernel/random/uuid ]]; then
    cat /proc/sys/kernel/random/uuid
  else
    # Fallback: construct UUID-shaped value from openssl bytes
    local hex
    hex=$(openssl rand -hex 16)
    printf '%s-%s-%s-%s-%s\n' \
      "${hex:0:8}" "${hex:8:4}" "4${hex:13:3}" \
      "$(printf '%x' $(( (0x${hex:16:2} & 0x3f) | 0x80 )))${hex:18:2}" \
      "${hex:20:12}"
  fi
}

# ---------------------------------------------------------------------------
# Helper: generate a compact HS256 JWT (no external deps — pure bash/openssl)
# Encodes: { "iss":"orbital-hub", "role":"owner", "tid":"<tenant_id>", "exp":<exp> }
# ---------------------------------------------------------------------------
gen_invite_jwt() {
  local secret="$1"
  local tenant_id="$2"
  local ttl_seconds="${3:-86400}"  # 24h default

  # base64url encode helper
  b64url() {
    openssl base64 -e -A | tr '+/' '-_' | tr -d '='
  }

  local now exp header payload
  now=$(date +%s)
  exp=$(( now + ttl_seconds ))

  header=$(printf '{"typ":"JWT","alg":"HS256"}' | b64url)
  payload=$(printf '{"iss":"orbital-hub","role":"owner","tid":"%s","iat":%d,"exp":%d}' \
    "${tenant_id}" "${now}" "${exp}" | b64url)

  local signing_input="${header}.${payload}"
  local signature
  signature=$(printf '%s' "${signing_input}" \
    | openssl dgst -sha256 -hmac "${secret}" -binary \
    | openssl base64 -e -A \
    | tr '+/' '-_' | tr -d '=')

  printf '%s.%s.%s\n' "${header}" "${payload}" "${signature}"
}

# ---------------------------------------------------------------------------
# Step 1: Generate master key + passwords
# ---------------------------------------------------------------------------
if [[ "$QUIET" -eq 0 ]]; then
  echo ""
  echo "  ============================================================"
  echo "  Orbital Hub Bootstrap"
  echo "  ============================================================"
fi

step "Generating hub master key..."
MASTER_KEY=$(openssl rand -hex 32)
ok "Hub master key generated (64 hex chars)"

step "Generating Postgres password..."
POSTGRES_PASSWORD=$(openssl rand -base64 24 | tr -dc 'a-zA-Z0-9' | head -c 32)
ok "Postgres password generated"

# ---------------------------------------------------------------------------
# Step 2: Tenant ID
# ---------------------------------------------------------------------------
step "Resolving default tenant ID..."
if [[ -n "$TENANT_ID_OVERRIDE" ]]; then
  DEFAULT_TENANT_ID="$TENANT_ID_OVERRIDE"
  ok "Using provided tenant ID: ${DEFAULT_TENANT_ID}"
else
  DEFAULT_TENANT_ID=$(gen_uuid)
  ok "Generated tenant ID: ${DEFAULT_TENANT_ID}"
fi

# ---------------------------------------------------------------------------
# Step 3: Write / update .env file
# ---------------------------------------------------------------------------
step "Writing .env..."
# If .env exists, remove any existing ORBITAL_ / HUB_ vars to avoid duplicates
if [[ -f "${ENV_FILE}" ]]; then
  TMP_ENV=$(mktemp)
  grep -v -E '^(ORBITAL_MODE|ORBITAL_HUB_MASTER_KEY|ORBITAL_HUB_TENANT_ID|ORBITAL_HOSTNAME|HUB_POSTGRES_PASSWORD)=' "${ENV_FILE}" > "${TMP_ENV}" || true
  mv "${TMP_ENV}" "${ENV_FILE}"
fi

cat >> "${ENV_FILE}" <<ENV
# Orbital Hub — generated by hub-bootstrap.sh on $(date -u +"%Y-%m-%dT%H:%M:%SZ")
ORBITAL_MODE=hub
ORBITAL_HUB_MASTER_KEY=${MASTER_KEY}
ORBITAL_HUB_TENANT_ID=${DEFAULT_TENANT_ID}
ORBITAL_HOSTNAME=${HOSTNAME}
HUB_POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
ENV
ok ".env written at ${ENV_FILE}"

# ---------------------------------------------------------------------------
# Step 4: Docker secrets directory
# ---------------------------------------------------------------------------
step "Creating Docker secrets directory..."
mkdir -p "${PROJECT_ROOT}/secrets"
printf '%s' "${MASTER_KEY}" > "${PROJECT_ROOT}/secrets/hub_master_key"
chmod 600 "${PROJECT_ROOT}/secrets/hub_master_key"
ok "secrets/hub_master_key written (chmod 600)"

# ---------------------------------------------------------------------------
# Step 5: Self-signed TLS cert (unless --skip-tls or cert already exists)
# ---------------------------------------------------------------------------
CERT_DIR="${PROJECT_ROOT}/nginx/certs"
mkdir -p "${CERT_DIR}"

if [[ "$SKIP_TLS" -eq 0 ]]; then
  if [[ -f "${CERT_DIR}/cert.pem" && -f "${CERT_DIR}/key.pem" ]]; then
    ok "TLS cert already exists at ${CERT_DIR} — skipping generation"
  else
    step "Generating self-signed TLS certificate for ${HOSTNAME}..."
    openssl req -x509 \
      -newkey rsa:4096 \
      -keyout "${CERT_DIR}/key.pem" \
      -out    "${CERT_DIR}/cert.pem" \
      -days 365 \
      -nodes \
      -subj "/CN=${HOSTNAME}" \
      -addext "subjectAltName=DNS:${HOSTNAME},DNS:localhost,IP:127.0.0.1" \
      2>/dev/null
    chmod 600 "${CERT_DIR}/key.pem"
    ok "Self-signed cert written to ${CERT_DIR}/cert.pem"
    warn "Self-signed cert generated. Replace with a CA-signed or Let's Encrypt cert before going live."
  fi
fi

# ---------------------------------------------------------------------------
# Step 6: Apply DB (start postgres, run migrations, create tenant)
# ---------------------------------------------------------------------------
if [[ "$APPLY_DB" -eq 1 && "$SKIP_DOCKER" -eq 0 ]]; then
  step "Starting hub-postgres container..."
  (cd "${PROJECT_ROOT}" && docker compose -f docker-compose.hub.yml up -d hub-postgres)

  step "Waiting for Postgres to be healthy..."
  MAX_WAIT=60
  elapsed=0
  while ! docker exec orbital-hub-postgres pg_isready -U orbital -d orbital_hub >/dev/null 2>&1; do
    sleep 2
    elapsed=$(( elapsed + 2 ))
    if [[ $elapsed -ge $MAX_WAIT ]]; then
      echo "ERROR: Postgres did not become healthy within ${MAX_WAIT}s" >&2
      exit 1
    fi
  done
  ok "Postgres is ready"

  step "Running Drizzle migrations..."
  DB_URL="postgres://orbital:${POSTGRES_PASSWORD}@localhost:${HUB_POSTGRES_PORT:-5433}/orbital_hub"
  (cd "${PROJECT_ROOT}" && DATABASE_URL="${DB_URL}" npm run db:migrate --workspace=packages/orchestrator 2>&1) \
    || { echo "ERROR: Migrations failed" >&2; exit 1; }
  ok "Migrations applied"

  step "Creating default tenant row..."
  psql "${DB_URL}" -v ON_ERROR_STOP=1 -c "
    INSERT INTO tenants (tenant_id, display_name, created_at)
    VALUES ('${DEFAULT_TENANT_ID}', 'Default Hub Tenant', NOW())
    ON CONFLICT (tenant_id) DO NOTHING;
  " >/dev/null 2>&1 || warn "tenants table not yet available (migrations may have skipped it)"
  ok "Default tenant created"
fi

# ---------------------------------------------------------------------------
# Step 7: Generate owner invite JWT
# ---------------------------------------------------------------------------
step "Generating initial owner invite token (24h single-use)..."
INVITE_TOKEN=$(gen_invite_jwt "${MASTER_KEY}" "${DEFAULT_TENANT_ID}" 86400)
INVITE_URL="https://${HOSTNAME}/join/${INVITE_TOKEN}"
ok "Invite token generated"

# ---------------------------------------------------------------------------
# Final output
# ---------------------------------------------------------------------------
if [[ "$QUIET" -eq 0 ]]; then
  echo ""
  echo "  ============================================================"
  echo "  Bootstrap complete!"
  echo "  ============================================================"
  echo ""
  echo "  Owner invite URL (valid 24h, single-use):"
  echo ""
  echo "    ${INVITE_URL}"
  echo ""
  echo "  On your laptop, run:"
  echo "    orbital join ${INVITE_URL}"
  echo ""
  echo "  To start the full stack:"
  echo "    docker compose -f docker-compose.hub.yml up -d"
  echo ""
  echo "  Hub will be available at: https://${HOSTNAME}"
  echo "  Health check:             https://${HOSTNAME}/health"
  echo ""
  echo "  IMPORTANT:"
  echo "    - Store ORBITAL_HUB_MASTER_KEY from .env securely."
  echo "    - Loss of the master key means loss of all agent credentials."
  if [[ "$SKIP_TLS" -eq 0 && -f "${CERT_DIR}/cert.pem" ]]; then
    echo "    - Replace the self-signed cert in nginx/certs/ with a real cert."
  fi
  echo ""
  echo "  ============================================================"
  echo ""
fi

# Always print the env block to stdout (piped usage friendly)
cat <<ENV_BLOCK
ORBITAL_MODE=hub
ORBITAL_HUB_MASTER_KEY=${MASTER_KEY}
ORBITAL_HUB_TENANT_ID=${DEFAULT_TENANT_ID}
ORBITAL_HOSTNAME=${HOSTNAME}
HUB_POSTGRES_PASSWORD=${POSTGRES_PASSWORD}
ENV_BLOCK
