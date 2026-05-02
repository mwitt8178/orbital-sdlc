# Round 7-03 — Implementation Plan (Engineer-Principal)
[Engineer-Principal · Opus · run-round7-03-federation-auth]

This complements the existing architecture.md with the concrete implementation plan I'm executing.

## Bounded contexts touched

| Context | Files | Purpose |
|---|---|---|
| `keys/` (NEW package alias) | `keys/install-key.ts`, `keys/envelope.ts` | Install keypair lifecycle + signEnvelope/verifyEnvelope primitives |
| `db/schema/` | `known-installs.ts` | Drizzle schema for hub-side install registry |
| `db/migrations/` | `0034_known_installs.sql` | Phase-1 additive create-table + indexes |
| `hub/auth/` (NEW server) | `middleware.ts`, `registration.ts`, `known-installs.ts` | Hub-side registration + envelope verification + revoke gates |
| `hub-client/` (extend) | `auth.ts` | Local-side outbound request signer; integrates with existing client |
| `trpc/middleware/auth.ts` (NEW) | tRPC middleware | Validates envelope on hub procedures, injects ctx.installId/role |
| `admin/hub-admin.ts` (modify) | replaces placeholder owner-token check with envelope-derived role check |
| `cli/` (NEW) | `orbital-invite.ts`, `orbital-join.ts` | CLI commands for pairing flow |
| `ui/` (extend) | `HubTab.tsx`, NEW `JoinHubFlow.tsx` | Pairing UI affordances |

## Aggregate boundaries

- `KnownInstall` aggregate (install_id PK, tenant_id, role, public_key, revoked_at). State transitions: registered → active → revoked.
- `InviteToken` is **not** persisted as an aggregate — it's a JWT signed by hub master key with `jti` tracked in an in-memory + DB-backed seen-jti table to enforce single-use. To keep this round small and avoid a second migration, jti uniqueness is enforced via `INSERT ... ON CONFLICT DO NOTHING` on a `known_installs.invite_jti` column (added in 0034).

## Event flow

1. **Invite create** (hub-side, owner only): owner runs `orbital invite create --role member`. Hub signs JWT with master key (already in `signing_keys` table). Returns invite URL.
2. **Join** (local-side): local installs runs `orbital join <invite-url>`. Local generates Ed25519 keypair (persisted via existing keychain shim or `~/.orbital/keys/install.json` for hub-mode-deployed laptops). POSTs to `/hub/register` with `{install_id, public_key, display_name, invite_token}`.
3. **Hub register** validates JWT (sig + expiry + jti unseen), inserts `known_installs(install_id, tenant_id, public_key, role, display_name, invite_jti)`, returns `{ok, tenant_id, hub_pubkey}`.
4. **Authenticated request** (every subsequent local→hub call): local signs envelope `{method, params_hash, ts, nonce}` with install privkey, sets headers `X-Orbital-Install-Id / X-Orbital-Sig / X-Orbital-Sig-Body`. Hub auth middleware decodes, validates ts (±60s), checks nonce LRU (5min), verifies sha256(body) matches params_hash, verifies Ed25519 sig against `known_installs[install_id].public_key`, rejects if `revoked_at IS NOT NULL`, otherwise injects `ctx.installId / ctx.tenantId / ctx.role`.

## IAM diff

None. This is application-layer auth between the laptop and the hub. No AWS IAM changes. The hub master key is loaded from env var (already exists in 7-07's bootstrap).

## DSQL schema diff

Migration 0034 adds:

```sql
CREATE TABLE IF NOT EXISTS known_installs (
  install_id    uuid        PRIMARY KEY,
  tenant_id     uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
  public_key    text        NOT NULL,
  role          text        NOT NULL CHECK (role IN ('owner','member','viewer')),
  display_name  text,
  invite_jti    text        NOT NULL,
  joined_at     timestamptz NOT NULL DEFAULT now(),
  last_seen_at  timestamptz,
  revoked_at    timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS known_installs_invite_jti_uniq
  ON known_installs (invite_jti);

CREATE INDEX IF NOT EXISTS known_installs_tenant_idx
  ON known_installs (tenant_id, revoked_at);
```

DSQL-safe: no FK, no triggers, no sequences, no extensions, additive only.

## Blast radius

- **If broken at hub registration**: invitees can't join — operator-visible immediately, no data loss.
- **If broken at envelope verify**: legitimate requests rejected — UI shows 401 banner; no silent data corruption since middleware fails closed.
- **If sig validation has a vulnerability** (e.g. accepts bad signatures): unauthenticated mutations on the hub. Mitigation: real Ed25519 via `@noble/ed25519`, no hand-rolled crypto. JCS-canonical body for sig payload (already in capabilities/canonical-json.ts).
- **Replay attack**: nonce LRU + 5min window. After expiry, ts check (±60s) catches replay. Defense in depth.
- **Revocation latency**: hub query each request (no caching beyond Postgres) — lookup is cheap (PK), tolerable until scale issues.

## Rollback strategy

- 0034 migration is additive. To roll back: `DROP TABLE known_installs CASCADE` (no FKs reference it). Hub admin /admin/installs gracefully returns [] if table missing (already implemented in 7-07).
- New auth middleware is opt-in: it only attaches to procedures that explicitly use `installProcedure` (analogue of `tenantProcedure`). Existing routers are unaffected unless updated.
- The hub-admin.ts placeholder owner-token check is replaced with envelope-derived role check, BUT the dev-mode escape (NODE_ENV=development AND no envelope) is preserved — dev workflows continue to work.

## Confidence: 95
- Real `@noble/ed25519` v2 (already vetted in 7-01 capabilities/keys.ts).
- JCS canonical JSON (already vetted in capabilities/canonical-json.ts).
- Real Postgres for tests, no mocks.
- Reuses existing keychain wrapper for private key persistence on test path.
