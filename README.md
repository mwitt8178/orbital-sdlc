# Orbital

Autonomous SDLC platform — multi-agent product factory, event-sourced, capability-gated.

## Getting started

```bash
git clone <this-repo>
cd orbital
npm install
npm run setup
```

`npm run setup` is the entire fresh-install workflow. It runs idempotently:

1. Ensures `~/.orbital/` directory tree exists
2. `docker compose up -d` (skipped if `DATABASE_URL` is already set)
3. Waits for Postgres readiness
4. Runs Drizzle migrations
5. Generates the master signing key (idempotent — re-uses an existing master if present)
6. Writes `~/.orbital/config/install.json` with `setup_completed_at: null`
7. Opens your browser at <http://localhost:3000>

Finish the rest of setup (Anthropic + Monday tokens, mode selection, sample data) in the in-app `/welcome` wizard that appears on first visit.

## Daily commands

```bash
npm run dev      # orchestrator + UI in watch mode
npm start        # orchestrator only (requires npm run build first)
npm run build    # build all three workspaces (types → orchestrator → ui)
npm test         # vitest run (unit + integration)
npm run lint
npm run migrate
```

- Orchestrator: <http://localhost:3000>
- UI dev server: <http://localhost:5173> (proxies `/api`, `/ws`, `/trpc` to the orchestrator)
- Health: <http://localhost:3000/health>
- **Admin console: <http://localhost:3000/admin>**

## Operations: the `/admin` console

Every operational action beyond setup, restore, and reset is in the web UI under `/admin`:

| Tab | What it does |
|---|---|
| Health | Live subsystem status (DB, WS hub, MCP gateway), uptime, install ID, metrics snapshot — auto-refresh every 5s |
| Workers | List active agent workers; SIGTERM individual workers (capability-gated) |
| Keys | Browse master + sub-keys + key history; rotate the active sub-key (capability-gated) |
| Backups | Encrypted-tarball list; trigger a new backup (capability-gated) |
| Verify | Walk the four-level attestation chain by capability_id or commit hash |
| Reset | DANGER ZONE — drops every schema, re-runs migrations, regenerates `install_id` (capability-gated, dual confirmation) |

### Capability gating

Mutations on `/admin` require an admin token, set via:

- Keychain entry `admin.api_token` (preferred)
- Env var `ADMIN_TOKEN` (fallback)
- Open dev mode: when `NODE_ENV=development` AND neither of the above are set, mutations succeed without a token (logged loudly server-side)

In the UI, click "Set admin token" in the header, paste the value, and save. The token lives in memory only — a page reload requires re-entry. It is never persisted to localStorage.

## Disaster recovery

The only command that must work even if the daemon is dead:

```bash
ORBITAL_BACKUP_PATH=/path/to/backup.tar.enc \
ORBITAL_BACKUP_PASSPHRASE='your phrase' \
npm run restore
```

Or with flags:

```bash
npm run restore -- --from /path/to/backup.tar.enc --passphrase 'your phrase'
```

Add `--force` to bypass the safety guard that refuses to restore over a non-empty database.

## Reset (development / demo only)

```bash
RESET_PHRASE="I understand" npm run reset
```

Drops every schema, re-runs migrations, writes a fresh `install.json` with a new `install_id` and `setup_completed_at: null`. Run `npm run setup` afterward to regenerate keys and reopen the welcome wizard.

## Architecture

Spec lives in `Docs/`:

- `Implementation-Plan.md` — phased build (this is the source of truth)
- `Orbital-SAO.md` — Solution Architecture
- `Orbital-PRD.md` — Product Requirements
- `TRDs/TRD-00..12.md` — per-module Technical Requirements

Repo layout per Implementation Plan §2:

```
packages/
  types/         # Shared Zod schemas + branded types
  orchestrator/  # Node 22 + TypeScript daemon (Fastify, Drizzle, postgres.js)
  ui/            # React 19 + Vite + Tailwind v4 SPA
scripts/         # npm-script driver shims (setup, restore, reset)
```

## Real-implementation rule

No mocks in `src/`. All tests use the real Docker Postgres. All external API calls (Anthropic, Monday) are real and throw `STARTUP_ERROR` if credentials are missing.

## Scripts reference

The three scripts that work even when the daemon is dead live under `scripts/`:

| Script | Purpose |
|---|---|
| `npm run setup` | Fresh install — Docker up, migrations, install.json, browser open |
| `npm run restore` | Emergency DB restore from encrypted tarball |
| `npm run reset` | DANGER — wipe schemas, re-migrate, fresh install.json |

All other operations (backup export, key rotation, attestation verify, worker management) are in the `/admin` web console. The `orbital` global binary and `packages/orchestrator/src/cli/` directory have been removed.
