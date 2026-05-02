# Hub Rollback Procedures

> Procedures for restoring the Orbital Hub from backup, rolling back a bad
> upgrade, and recovering from a compromised master key.

---

## Table of contents

1. [Restore from backup](#1-restore-from-backup)
2. [Roll back a hub upgrade](#2-roll-back-a-hub-upgrade)
3. [Master key rotation rollback](#3-master-key-rotation-rollback)
4. [Compromised master key recovery](#4-compromised-master-key-recovery)
5. [Emergency: full rebuild from backup](#5-emergency-full-rebuild-from-backup)

---

## 1. Restore from backup

Use when: data corruption, accidental deletion, or disaster recovery.

### Prerequisites

- `ORBITAL_HUB_MASTER_KEY` matching the backup's encryption key
- `DATABASE_URL` for the target Postgres instance
- The backup file (`.sql.gz.enc`)

### Procedure

```bash
# 1. Stop the hub (prevent new writes during restore)
docker compose -f docker-compose.hub.yml stop orbital-hub

# 2. List available backups
ls -lh ./backups/

# 3. Restore (interactive — requires confirmation)
bash scripts/hub-restore.sh \
  --backup=./backups/orbital-hub-backup-<timestamp>.sql.gz.enc

# 4. Verify row counts
psql "${DATABASE_URL}" -c "SELECT COUNT(*) FROM events;"
psql "${DATABASE_URL}" -c "SELECT COUNT(*) FROM tasks;"

# 5. Restart the hub
docker compose -f docker-compose.hub.yml start orbital-hub

# 6. Verify health
curl -f https://${ORBITAL_HOSTNAME}/health
```

### Automated restore (CI / scripts)

```bash
# --yes-i-know-what-i-am-doing skips the interactive confirmation
bash scripts/hub-restore.sh \
  --backup=./backups/orbital-hub-backup-<timestamp>.sql.gz.enc \
  --yes-i-know-what-i-am-doing
```

### Decryption failed

If restore fails with "bad decrypt":

1. You are using the wrong `ORBITAL_HUB_MASTER_KEY`. The key must match the
   one that was active when the backup was created.
2. Check `secrets/hub_master_key.prev` — if a rotation happened recently,
   the old key may still be there:

```bash
ORBITAL_HUB_MASTER_KEY=$(cat secrets/hub_master_key.prev) \
  bash scripts/hub-restore.sh --backup=<file> --yes-i-know-what-i-am-doing
```

---

## 2. Roll back a hub upgrade

Use when: a new hub version introduced a regression and you need to revert.

### Roll back to the previous Docker image

```bash
# 1. Check what tag is currently running
docker ps --format '{{.Image}}' | grep orbital-hub

# 2. Stop the current hub
docker compose -f docker-compose.hub.yml stop orbital-hub

# 3. Edit docker-compose.hub.yml: change the image tag to the previous version
#    e.g. change ghcr.io/orbital-oss/orbital-hub:1.2.0 → orbital-hub:1.1.0
#    OR: set HUB_IMAGE env var:
export HUB_IMAGE=ghcr.io/orbital-oss/orbital-hub:1.1.0

# 4. Pull the old image
docker compose -f docker-compose.hub.yml pull orbital-hub

# 5. Start with the old image
docker compose -f docker-compose.hub.yml up -d orbital-hub

# 6. Verify
curl -f https://${ORBITAL_HOSTNAME}/health
```

### Roll back a schema migration

Orbital uses additive-only migrations (no destructive DDL). There is no "down"
migration. If a migration added a column or table that is causing issues:

1. Stop the hub.
2. Restore from a pre-migration backup (see §1).
3. Start the **previous** hub image (which will not re-run the bad migration
   because it doesn't know about it).
4. File a bug.

---

## 3. Master key rotation rollback

Use when: a key rotation happened but the new key is not working correctly
(e.g. hub fails to start, or new backups fail to encrypt).

The old key is kept for 24h in `secrets/hub_master_key.prev`.

### Procedure

```bash
# 1. Check the old key is still present
ls -la secrets/hub_master_key.prev

# 2. Restore the old key
cp secrets/hub_master_key secrets/hub_master_key.new  # save new key just in case
cp secrets/hub_master_key.prev secrets/hub_master_key

# 3. Update .env to use the old key
OLD_KEY=$(cat secrets/hub_master_key)
# Edit .env: replace ORBITAL_HUB_MASTER_KEY line
sed -i "s|^ORBITAL_HUB_MASTER_KEY=.*|ORBITAL_HUB_MASTER_KEY=${OLD_KEY}|" .env

# 4. Restart hub
docker compose -f docker-compose.hub.yml restart orbital-hub

# 5. Verify
curl -f https://${ORBITAL_HOSTNAME}/health

# 6. Investigate why the new key caused a problem before re-rotating.
```

---

## 4. Compromised master key recovery

Use when: the master key was exposed (leaked to logs, accidentally committed,
etc.) and must be treated as compromised.

**Urgency: high. Attackers with the master key can decrypt all backups.**

### Immediate steps

```bash
# 1. Take the hub offline immediately
docker compose -f docker-compose.hub.yml stop

# 2. Take a fresh backup BEFORE changing the key
#    (encrypted with the old/compromised key — but this is your most current data)
DATABASE_URL="postgres://orbital:<password>@localhost:5433/orbital_hub" \
  bash scripts/hub-backup.sh

# 3. Rotate the master key (this generates a new key)
bash scripts/hub-rotate-master-key.sh --yes-i-know-what-i-am-doing

# 4. Re-encrypt the backup you just took with the new key:
#    (a) decrypt with old key → (b) re-encrypt with new key
OLD_KEY_HEX=$(cat secrets/hub_master_key.prev)
NEW_KEY_HEX=$(cat secrets/hub_master_key)

derive_aes_key() {
  local master_key="$1"
  printf '%s' "${master_key}:orbital-backup-aes-key" \
    | openssl dgst -sha256 -binary | xxd -p -c 256 | head -c 64
}

OLD_AES=$(derive_aes_key "${OLD_KEY_HEX}")
NEW_AES=$(derive_aes_key "${NEW_KEY_HEX}")

# Find the most recent backup
LATEST_BACKUP=$(ls -t ./backups/orbital-hub-backup-*.sql.gz.enc | head -1)

# Re-encrypt
openssl enc -aes-256-cbc -d -pbkdf2 -iter 100000 -pass "pass:${OLD_AES}" \
  -in "${LATEST_BACKUP}" \
  | openssl enc -aes-256-cbc -pbkdf2 -iter 100000 -pass "pass:${NEW_AES}" \
  -out "${LATEST_BACKUP}.reenc"

# Replace original
mv "${LATEST_BACKUP}.reenc" "${LATEST_BACKUP}"

# 5. Start the hub with the new key
docker compose -f docker-compose.hub.yml up -d orbital-hub

# 6. Verify
curl -f https://${ORBITAL_HOSTNAME}/health

# 7. Delete the old key immediately — do NOT wait 24h in a compromise scenario
rm secrets/hub_master_key.prev

# 8. Rotate all tokens (ORBITAL_OWNER_TOKEN, WS_SESSION_TOKEN, ADMIN_TOKEN)
#    and inform all operators to re-pair.
```

---

## 5. Emergency: full rebuild from backup

Use when: host is lost, Postgres is unrecoverable. Start from scratch.

```bash
# 1. On a new host: clone repo and bootstrap
git clone https://github.com/orbital-oss/orbital.git
cd orbital

# 2. Copy your .env (or reconstruct it with backed-up credentials)
#    The critical values are:
#    - ORBITAL_HUB_MASTER_KEY  (must match the backup's key)
#    - HUB_POSTGRES_PASSWORD
#    - ORBITAL_HOSTNAME

# 3. Start Postgres only (no hub yet — we need to restore before hub starts)
docker compose -f docker-compose.hub.yml up -d hub-postgres

# 4. Wait for Postgres to be healthy
until docker exec orbital-hub-postgres pg_isready -U orbital -d orbital_hub; do
  sleep 2
done

# 5. Run migrations to create the schema
DATABASE_URL="postgres://orbital:<password>@localhost:5433/orbital_hub" \
  npm run db:migrate --workspace=packages/orchestrator

# 6. Restore from latest backup
bash scripts/hub-restore.sh \
  --backup=<path-to-backup> \
  --yes-i-know-what-i-am-doing

# 7. Start the full stack
docker compose -f docker-compose.hub.yml up -d

# 8. Verify
curl -f https://${ORBITAL_HOSTNAME}/health

# 9. Notify all operators to reconnect
#    Their installs should reconnect automatically on next sync.
```

---

## Backup verification

Run monthly to ensure backups are recoverable:

```bash
# Decrypt and check the pg_dump header (no DB write needed)
MASTER_KEY=$(cat secrets/hub_master_key)
LATEST=$(ls -t ./backups/orbital-hub-backup-*.sql.gz.enc | head -1)

derive_aes_key() {
  printf '%s' "${1}:orbital-backup-aes-key" \
    | openssl dgst -sha256 -binary | xxd -p -c 256 | head -c 64
}

AES=$(derive_aes_key "${MASTER_KEY}")

openssl enc -aes-256-cbc -d -pbkdf2 -iter 100000 -pass "pass:${AES}" \
  -in "${LATEST}" \
  | gunzip -c \
  | head -5

# Expected output includes:
# -- PostgreSQL database dump
```
