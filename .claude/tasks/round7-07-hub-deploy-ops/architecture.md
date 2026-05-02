# Round 7-07 — Hub Deployment + Operations

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Low · Estimate: M

## Depends on
7-01 (hub mode exists)

## Why
The hub must be deployable by anyone wanting to self-host. Today the orchestrator is `npm run dev` for development; hub mode needs a production-grade Docker image, compose stack, deploy guide, and basic admin tooling. Without this, "self-host the hub" is theoretical.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| NEW `Dockerfile.hub` | New | Multi-stage: build TS, prune dev deps, run as non-root |
| NEW `docker-compose.hub.yml` | New | Hub + Postgres 16 + minimal nginx for TLS termination |
| NEW `scripts/hub-bootstrap.sh` | New | First-run: generates hub master key, creates initial owner invite, prints connection URL |
| NEW `scripts/hub-backup.sh` | New | pg_dump + R2/S3 upload, encrypted with hub master key |
| NEW `scripts/hub-restore.sh` | New | Reverse of backup |
| NEW `scripts/hub-rotate-master-key.sh` | New | Rotation procedure (rare, logged) |
| `packages/orchestrator/src/admin/hub-admin.ts` | NEW | Hub-mode admin endpoints: `/admin/health`, `/admin/installs`, `/admin/audit-tail`, `/admin/backup-status` |
| NEW `docs/hub-deployment.md` | New | Step-by-step self-host guide |
| NEW `.github/workflows/hub-image.yml` | New | CI builds + publishes hub Docker image to GHCR on tag |

## Self-host stack
```yaml
# docker-compose.hub.yml
services:
  hub:
    image: ghcr.io/<org>/orbital-hub:latest
    environment:
      ORBITAL_MODE: hub
      DATABASE_URL: postgres://orbital:${DB_PASSWORD}@db:5432/orbital_hub
      ORBITAL_HUB_MASTER_KEY_PATH: /run/secrets/hub_master_key
    secrets: [hub_master_key]
    depends_on: [db]
    ports: ["3000:3000"]
    restart: unless-stopped

  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: orbital
      POSTGRES_PASSWORD: ${DB_PASSWORD}
      POSTGRES_DB: orbital_hub
    volumes: [pgdata:/var/lib/postgresql/data]
    healthcheck: { test: ["CMD", "pg_isready"], interval: 5s }
    restart: unless-stopped

  nginx:
    image: nginx:alpine
    volumes: [./nginx.conf:/etc/nginx/conf.d/default.conf:ro]
    ports: ["443:443", "80:80"]
    depends_on: [hub]

secrets:
  hub_master_key:
    file: ./secrets/hub_master_key

volumes:
  pgdata:
```

## Bootstrap flow
```
$ ORBITAL_HOSTNAME=orbital.team.dev ./scripts/hub-bootstrap.sh
Generating hub master key... ✓
Starting Postgres... ✓
Running migrations... ✓
Creating tenant 'default'... ✓
Generating initial owner invite token... ✓

Owner invite URL (valid 24h, single-use):
  https://orbital.team.dev/join/eyJ0eXAi...

On your laptop, run:
  orbital join https://orbital.team.dev/join/eyJ0eXAi...

Hub is up at https://orbital.team.dev
Health: https://orbital.team.dev/health
```

## Admin endpoints (hub-only)
- `GET /admin/health` — version, uptime, db status, ws connections, tenant count
- `GET /admin/installs` — list known_installs (owner-auth)
- `POST /admin/installs/:id/revoke` — revoke install (owner-auth, logged)
- `GET /admin/audit-tail?since=` — recent audit events (owner-auth)
- `POST /admin/backup` — trigger backup
- `GET /admin/backup/status` — backup history

## Frontend UX
NEW `packages/ui/src/pages/HubAdmin.tsx` — only visible when `ctx.role === 'owner'`:
- Health: subsystem statuses, uptime, version
- Installs: table of known_installs with revoke action
- Audit tail: recent events, filterable
- Backup: list of backups, "Trigger backup now", "Restore from..." (with strong confirmation)

## Acceptance criteria
1. `docker compose -f docker-compose.hub.yml up -d` brings hub + Postgres up on a clean machine.
2. `hub-bootstrap.sh` generates master key, runs migrations, prints invite URL.
3. `orbital join <url>` from a separate laptop completes registration and the laptop can authenticate to the hub.
4. `/admin/health` returns full status JSON.
5. `hub-backup.sh` produces encrypted backup file; `hub-restore.sh` restores to a clean DB; original data verifies post-restore.
6. CI publishes hub Docker image to GHCR on `v*` tag push.
7. Deployment guide gets a non-engineer through self-host successfully (manual checkpoint).
8. Master key rotation: documented + scripted; tested end-to-end.

## Hard-stop grep checks
```
ls Dockerfile.hub docker-compose.hub.yml scripts/hub-bootstrap.sh scripts/hub-backup.sh scripts/hub-restore.sh
grep -E "ORBITAL_MODE.*hub" docker-compose.hub.yml
grep -E "/admin/health|/admin/installs" packages/orchestrator/src/admin/hub-admin.ts
ls packages/ui/src/pages/HubAdmin.tsx docs/hub-deployment.md
```

## Out of scope (Round 8)
- Multi-region replication
- Read replicas
- Auto-scaling (horizontal hub instances behind LB)
- Managed-cloud SaaS deployment (this is for self-host; SaaS is a product decision)

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round7-07-hub-deploy-ops]`
