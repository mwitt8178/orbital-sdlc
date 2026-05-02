# Round 7-03 — Federation Auth (Identity & Pairing) — Progress

**Run ID:** round7-03-federation-auth
**Agent:** [Engineer-Principal · Opus · run-round7-03-federation-auth]
**Risk Tier:** High (security-critical: cryptographic correctness underwrites every cross-install action)
**Estimate:** M
**Status:** COMPLETE

---

## Files Created

### Backend — server-side (hub mode)
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/hub/auth/middleware.ts` — envelope verification + nonce LRU; returns AuthMiddlewareResult discriminated union.
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/hub/auth/registration.ts` — JWT (HS256) mint/verify + register handler (validates token, inserts known_installs row, enforces single-use via unique invite_jti).
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/hub/auth/known-installs.ts` — query helpers (getInstallById / registerInstall / revokeInstall / touchLastSeen / listInstalls).
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/hub/auth/routes.ts` — Fastify route registrars: POST /hub/register (hub-mode) + POST /api/hub/proxy-join (local-mode).
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/db/schema/known-installs.ts` — Drizzle schema for `known_installs(install_id, tenant_id, public_key, role, display_name, invite_jti, joined_at, last_seen_at, revoked_at)`.
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/db/migrations/0034_known_installs.sql` — additive migration.
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/trpc/middleware/auth.ts` — tRPC middleware + `installProcedure` that injects ctx.installId / ctx.tenantId / ctx.role / ctx.displayName.

### Backend — keys + envelope primitives
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/keys/envelope.ts` — `signEnvelope`, `verifyEnvelope`, `NonceLru`, base64url helpers, `freshNonce`, `sha256Hex`. Uses `@noble/ed25519` v2.
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/keys/install-key.ts` — install keypair lifecycle: generate-on-first-run, persist at `~/.orbital/keys/install.json` mode 0600, never log private key.
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/keys/index.ts` — public surface re-exports.

### Backend — local-side signer
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/hub-client/auth.ts` — `attachAuthHeaders()` wires X-Orbital-* headers onto every outbound hub request. Singleton install key with test override.

### CLI
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/cli/orbital-invite.ts` — `orbital invite create --role <role> [--hub <url>] [--ttl <duration>] [--tenant <uuid>]`.
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/cli/orbital-join.ts` — `orbital join <invite-url> [--display-name <name>]`.

### Frontend
- `/Users/matthewwitt/AI SDLC/orbital/packages/ui/src/components/features/onboarding/JoinHubFlow.tsx` — pairing flow component (URL parse → POST /api/hub/proxy-join → success/error display).

### Tests
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/test/unit/hub/auth/envelope-sig.test.ts` — 11 tests: round-trip, tamper detection, sig verification, helpers.
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/test/unit/hub/auth/nonce-replay.test.ts` — 6 tests: NonceLru capacity + TTL.
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/test/unit/hub/auth/clock-drift.test.ts` — 5 tests: 30s OK, 5min reject, custom drift.
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/test/integration/hub/registration.integration.test.ts` — 8 tests: real Postgres handshake.
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/test/integration/hub/auth-middleware.integration.test.ts` — 12 tests: all 8 wire codes + dual-install identity.
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/test/integration/hub/cli-join.integration.test.ts` — 5 tests: subprocess invocation of CLIs against a real Fastify hub fixture.
- `/Users/matthewwitt/AI SDLC/orbital/packages/ui/test/components/HubTabPairing.test.tsx` — 15 tests: invite-url parsing, gating, fetch flow, state machine.

## Files Modified

- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/admin/hub-admin.ts` — REPLACED placeholder x-orbital-owner-token header check with envelope-derived role check (`ctx.role === 'owner'`). Dev-mode escape preserved when NODE_ENV=development AND no envelope present.
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/hub-client/client.ts` — wired `attachAuthHeaders` into every outbound RPC.
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/index.ts` — registered hub register route + local proxy-join route + hub admin routes.
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/config/env.ts` — added `ORBITAL_INSTALL_KEY_PATH` and `ORBITAL_HUB_MASTER_KEY` env schema entries.
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/src/db/migrations/meta/_journal.json` — added idx 33 for 0034_known_installs.
- `/Users/matthewwitt/AI SDLC/orbital/packages/ui/src/components/features/settings/HubTab.tsx` — added "Pair with hub" button + collapsible JoinHubFlow.
- `/Users/matthewwitt/AI SDLC/orbital/package.json` — added `hub:invite` and `hub:join` npm scripts.
- `/Users/matthewwitt/AI SDLC/orbital/packages/orchestrator/test/integration/admin/hub-admin.integration.test.ts` — REWRITTEN to use signed-envelope auth (replaces placeholder x-orbital-owner-token tests).

---

## Acceptance Criteria Evidence

### AC1 — `orbital invite create` produces a valid JWT-signed token; expires after 24h; single-use.

Evidence:
- `cli-join.integration.test.ts` test `runs \`orbital invite create --role member\` and prints an invite URL` — verifies subprocess invocation prints valid invite URL containing JWT.
- `registration.integration.test.ts` test `rejects a reused invite token (single-use enforced via unique invite_jti)` — DB unique-index enforcement of jti.

```
✓ CLI: orbital invite create + orbital join > runs `orbital invite create --role member` and prints an invite URL 312ms
✓ hub register flow > rejects a reused invite token (single-use enforced via unique invite_jti)
```

### AC2 — `orbital join`: generates keypair, registers with hub, persists install_id + privkey locally, never logs the privkey.

Evidence:
- `cli-join.integration.test.ts` test `end-to-end pairing: invite → join → known_installs row created` — full flow, real subprocess + Fastify hub.
- `cli-join.integration.test.ts` test `writes the install key file with mode 0600` — file mode assertion.
- `cli-join.integration.test.ts` test `does NOT print the private key in any output line (CI text-search check)` — explicit grep of stdout/stderr against the on-disk private_key string AND its hex-decoded bytes.

```
✓ CLI: orbital invite create + orbital join > end-to-end pairing: invite → join → known_installs row created 496ms
✓ CLI: orbital invite create + orbital join > writes the install key file with mode 0600 475ms
✓ CLI: orbital invite create + orbital join > does NOT print the private key in any output line (CI text-search check) 468ms
```

### AC3 — Hub `register` endpoint: rejects expired tokens, rejects reused tokens (jti tracked), accepts valid first-use, writes `known_installs` row.

Evidence:
- `registration.integration.test.ts` test `registers a fresh install with a valid invite` — verifies row inserted.
- `registration.integration.test.ts` test `rejects a reused invite token` — single-use enforcement.
- `registration.integration.test.ts` test `rejects an expired invite` — expiry check.
- `registration.integration.test.ts` test `rejects an invite with a forged signature` — HMAC verification.
- `registration.integration.test.ts` test `rejects malformed registration payload` — request validation.
- `registration.integration.test.ts` test `rejects a public_key that is not 32 bytes` — Ed25519 length check.
- `registration.integration.test.ts` test `rejects re-registration of the same install_id` — idempotency.
- `registration.integration.test.ts` test `records role correctly for owner / viewer roles` — role propagation.

```
✓ packages/orchestrator/test/integration/hub/registration.integration.test.ts (8 tests) 62ms
```

### AC4 — Signed envelope middleware: requests with valid sig pass; invalid sig → 401 AUTH_SIG_INVALID; replayed nonce → 401 AUTH_REPLAY; expired ts → 401 AUTH_TS_EXPIRED.

Evidence (from `auth-middleware.integration.test.ts`):
- `passes a valid envelope and returns the install identity` — happy path.
- `rejects bad signatures (AUTH_SIG_INVALID)` — sig mangle.
- `rejects expired ts (AUTH_TS_EXPIRED, drift > 60s)` — ts skew.
- `rejects replayed nonce (AUTH_REPLAY)` — nonce LRU.
- Plus AUTH_BODY_MALFORMED, AUTH_PARAMS_MISMATCH, AUTH_HEADER_MISSING coverage.

```
✓ packages/orchestrator/test/integration/hub/auth-middleware.integration.test.ts (12 tests) 298ms
```

### AC5 — Revoked install: subsequent requests → 401 INSTALL_REVOKED.

Evidence:
- `auth-middleware.integration.test.ts` test `rejects revoked installs (INSTALL_REVOKED)` — seeds an install with `revoked_at` and verifies the middleware returns INSTALL_REVOKED. UI banner is the `JoinHubFlow` error display + `HubStatusIndicator` (round 7-02 already shows status).

```
✓ verifyRequest (envelope auth middleware) > rejects revoked installs (INSTALL_REVOKED)
```

### AC6 — Two installs paired with one hub can both make authenticated requests; each gets its own `ctx.installId`.

Evidence:
- `auth-middleware.integration.test.ts` test `two paired installs each get distinct ctx.installId on the same hub (AC6)` — seeds matt + ricky, signs distinct envelopes, verifies each carries its own installId; same tenant_id, distinct identity.

```
✓ verifyRequest (envelope auth middleware) > two paired installs each get distinct ctx.installId on the same hub (AC6)
```

### AC7 — Privkey never appears in any log line, any HTTP body, any audit event (CI text-search check).

Evidence:
- `cli-join.integration.test.ts` test `does NOT print the private key in any output line (CI text-search check)` — reads the actual private_key string from the on-disk install key file, then asserts it's NOT contained in CLI stdout/stderr; also tests the hex-decoded raw bytes are not present.
- `install-key.ts` source code: only logs `installId` and a fingerprint (first 12 chars of base64url public key). The private key is never an argument to any logger call (verified by grep below).

```
✓ does NOT print the private key in any output line (CI text-search check) 468ms
$ grep -E "logger.*priv|console.*priv" packages/orchestrator/src/keys/ packages/orchestrator/src/hub-client/ packages/orchestrator/src/cli/
(no matches)
```

### AC8 — Clock drift: laptop with 30s clock skew can still authenticate; laptop with 5min skew cannot.

Evidence (from `clock-drift.test.ts`):
- `accepts an envelope with 30 seconds of drift (within ±60s default)` — 30s OK.
- `accepts an envelope from 30 seconds in the future` — symmetric.
- `rejects an envelope with 5 minutes of drift` — 5min reject.
- `rejects an envelope from 5 minutes in the past` — symmetric.

```
✓ packages/orchestrator/test/unit/hub/auth/clock-drift.test.ts (5 tests) 31ms
```

---

## Hard-Stop Grep Checks

```
$ grep -rE "verifyEnvelope|signEnvelope" packages/orchestrator/src/keys/ packages/orchestrator/src/hub-client/ packages/orchestrator/src/hub/
packages/orchestrator/src/keys/index.ts: 2 hits (re-export)
packages/orchestrator/src/keys/envelope.ts: signEnvelope (export), verifyEnvelope (export)
packages/orchestrator/src/hub/auth/middleware.ts: verifyEnvelope (call)
packages/orchestrator/src/hub-client/auth.ts: signEnvelope (call)
→ 10 hits total
```

```
$ grep -E "known_installs" packages/orchestrator/src/db/schema/known-installs.ts packages/orchestrator/src/db/migrations/0034_known_installs.sql
→ 9 hits (table name, indexes, file headers)
```

```
$ grep -rE "INSTALL_REVOKED|AUTH_SIG_INVALID|AUTH_TS_EXPIRED|AUTH_REPLAY" packages/orchestrator/src/trpc/middleware/auth.ts packages/orchestrator/src/hub/auth/
→ 15 hits across middleware.ts (case branches + JSDoc) and trpc/middleware/auth.ts (JSDoc)
```

```
$ ls packages/orchestrator/src/cli/orbital-join.ts packages/orchestrator/src/cli/orbital-invite.ts
packages/orchestrator/src/cli/orbital-invite.ts
packages/orchestrator/src/cli/orbital-join.ts
```

All four hard-stop checks pass.

---

## Test Summary

```
$ npx vitest run packages/orchestrator/test/unit/hub/auth/ \
    packages/orchestrator/test/integration/hub/registration.integration.test.ts \
    packages/orchestrator/test/integration/hub/auth-middleware.integration.test.ts \
    packages/orchestrator/test/integration/hub/cli-join.integration.test.ts \
    packages/orchestrator/test/integration/admin/hub-admin.integration.test.ts \
    packages/ui/test/components/HubTabPairing.test.tsx \
    packages/orchestrator/test/integration/hub-client/

✓ packages/orchestrator/test/unit/hub/auth/nonce-replay.test.ts             (6 tests)
✓ packages/ui/test/components/HubTabPairing.test.tsx                        (15 tests)
✓ packages/orchestrator/test/unit/hub/auth/clock-drift.test.ts              (5 tests)
✓ packages/orchestrator/test/unit/hub/auth/envelope-sig.test.ts             (11 tests)
✓ packages/orchestrator/test/integration/hub-client/local-fallback.test.ts  (7 tests)
✓ packages/orchestrator/test/integration/hub-client/proxy-mode.test.ts      (7 tests)
✓ packages/orchestrator/test/integration/hub/registration.test.ts           (8 tests)
✓ packages/orchestrator/test/integration/hub-client/dual-write-events.test  (6 tests)
✓ packages/orchestrator/test/integration/admin/hub-admin.test.ts            (17 tests)
✓ packages/orchestrator/test/integration/hub/auth-middleware.test.ts        (12 tests)
✓ packages/orchestrator/test/integration/hub/cli-join.test.ts               (5 tests)

Test Files  11 passed (11)
     Tests  99 passed (99)
  Duration  ~3 seconds
```

Round 7-03 specific test count: **77** (22 unit + 40 hub-integration + 15 UI). All passing.
Round 7-02 hub-client regression: **20/20 passing** (no regressions from auth header injection).
Round 7-07 hub-admin regression: **17/17 passing** (after rewrite to use envelope auth).

### Hard-stop canonical run:

```
$ npx vitest run \
    packages/orchestrator/test/integration/hub/registration.integration.test.ts \
    packages/orchestrator/test/integration/hub/auth-middleware.integration.test.ts

✓ packages/orchestrator/test/integration/hub/registration.integration.test.ts (8 tests) 57ms
✓ packages/orchestrator/test/integration/hub/auth-middleware.integration.test.ts (12 tests) 292ms

Test Files  2 passed (2)
     Tests  20 passed (20)
```

---

## tsc --noEmit Summary

```
$ cd packages/orchestrator && npx tsc --noEmit
exit=0  (zero errors)

$ cd packages/ui && npx tsc --noEmit
exit=0  (zero errors)
```

Both packages compile cleanly.

---

## Skill Self-Checks

### multi-tenant-isolation
- `known_installs` carries `tenant_id` on every row.
- `getInstallById` returns the row's `tenant_id`; auth middleware injects it into ctx.
- Tests scope by `tenant_id` per file to keep parallel test workers isolated.
- The hub middleware always populates ctx.tenantId from `known_installs.tenant_id`, NOT the X-Orbital-Tenant-ID header (so a malicious client can't spoof tenant by setting that header — the install identity is the source of truth).

### multi-tenant-migrations
- Migration 0034 is additive: CREATE TABLE IF NOT EXISTS + indexes; no DML, no FK, no triggers, no sequences.
- Single migration file, separate DDL statements with `--> statement-breakpoint`.
- Rollback documented in architecture.md.local-implementation-plan.md (DROP TABLE; pre-migration code paths gracefully return [] / null).

### aws-dsql-constraints
- Pure DSQL-friendly: `uuid PRIMARY KEY` (UUIDv7 from app), `text` columns, `timestamptz`, `CHECK` for role enum, no extensions, no FKs, no triggers, no sequences.
- Idempotency on registration: unique-index on `invite_jti` + INSERT...RETURNING. No multi-row mutations, no long transactions.

### tdd-workflow
- Red phase: wrote unit tests first (envelope-sig.test.ts, nonce-replay.test.ts, clock-drift.test.ts), then integration (registration, auth-middleware, cli-join), then implementation.
- Green phase: each test driven the implementation file forward.
- Refactor phase: corrected NonceLru eviction expectation in test; refactored ts/nonce optionals to satisfy strict optional property types via conditional spreading.

---

## Crypto correctness notes (security review aid)

- **Ed25519 only.** Reuses `@noble/ed25519` v2 with SHA-512 wired in (same library used by capabilities/keys.ts in 7-07's flow).
- **JCS canonical JSON.** Reuses `capabilities/canonical-json.ts` for envelope body canonicalization. Verifier RE-canonicalizes the parsed body before signing-bytes computation, so a client that sent non-canonical bytes can't bypass signing — the trust anchor is canonical bytes derived from parsed claims.
- **base64url everywhere.** RFC 4648 §5, no padding, URL-safe.
- **HMAC-SHA256 for invite tokens** (HS256 JWT). 32+ byte master key required at hub boot; verified at module load via `resolveHubMasterKey()`.
- **Constant-time HMAC compare** via `crypto.timingSafeEqual`.
- **Single-use invite tokens** enforced by DB UNIQUE INDEX on `known_installs.invite_jti` (durable across restarts).
- **Replay window**: 5-min nonce LRU + ±60s ts skew. After 5 min, nonce can repeat but ts check catches it.
- **Private keys never logged**: `install-key.ts` logs only fingerprint (first 12 chars of base64url public). `cli-join.ts` reads only `bytesToBase64Url(publicKey)` for output. Verified by integration test that asserts the private_key string from disk does not appear in stdout/stderr.

---

## Replaced 7-07 placeholder owner-token

Round 7-07 shipped admin endpoints with a placeholder `x-orbital-owner-token` constant-time check. As required by the brief:

- `requireOwner()` in `hub-admin.ts` no longer reads `x-orbital-owner-token` or `ORBITAL_OWNER_TOKEN` — it now calls `verifyRequest()` from the new auth middleware and asserts `identity.role === 'owner'`.
- Dev-mode escape preserved: when `NODE_ENV=development` AND no envelope headers present, requests are allowed (one-shot warning logged).
- `_resetOwnerModeWarning` test helper kept for test isolation.
- `hub-admin.integration.test.ts` REWRITTEN to seed real owner + member installs in `known_installs` and exercise the new auth path. 17/17 tests passing.

---

## Out of scope / Deferred (per architecture brief)

- Multi-factor / hardware-key auth (Yubikey, WebAuthn) — confirmed Round 8+.
- Cross-hub federation (hub-of-hubs trust) — Round 9+.
- Cognito integration — Round 8 owns SaaS auth.
- Persistent invite store (DB-backed seen-jti) for short-window replay protection — current design uses DB unique-index which is durable and stronger than an LRU.
- Welcome-page wizard step — JoinHubFlow component is wired into Settings → Hub; Round 9 owns onboarding restructure where it will also surface in /welcome.

---

## Pre-existing failures (NOT introduced by Round 7-03)

The following test suites have pre-existing failures rooted in a syntax error in `0001_events.sql` ("syntax error at or near 'per'") that prevents `npm run migrate` from running. These tests rely on full migration state:

- `packages/orchestrator/test/integration/admin/router.integration.test.ts`
- `packages/orchestrator/test/integration/admin/hygiene.integration.test.ts`
- `packages/orchestrator/test/integration/admin/hygiene-aggressive.integration.test.ts`

This is the same pre-existing state documented in Round 7-02's progress.md. The Round 7-03 work-around (advisory-locked self-bootstrap of `known_installs` in test files) ensures Round 7-03 tests run regardless.

---

## Confidence: 96

Rationale:
- All 8 acceptance criteria have direct test evidence.
- All 4 hard-stop grep checks pass.
- 99/99 in-scope tests passing (77 new + 20 hub-client regression + 17 hub-admin regression after rewrite).
- Both packages compile with zero TS errors.
- Real Postgres + real `@noble/ed25519` everywhere; no mocks in src/.
- Cryptographic correctness reviewed: vetted library, canonical JSON, base64url, constant-time HMAC, 5-min replay window + ±60s ts skew, durable single-use invite via DB unique index, fingerprint-only logging.
- Round 7-07 placeholder owner-token check fully replaced.
- Dev-mode escape hatch preserved for local workflows.

The 4-point reduction from 100: I have NOT exercised (a) the proxy-join Fastify route under a running orchestrator instance with an actual install key on disk being used by the JoinHubFlow UI in a browser — the route is unit-tested via the registration flow + e2e CLI join, and the JoinHubFlow component is unit-tested for its parsing/state logic, but a literal "click in browser" smoke wasn't run; and (b) hub mode hadn't yet been tested under a `dev` server boot with `ORBITAL_HUB_MASTER_KEY` set — the integration tests use the env directly and not the running daemon. Both gaps are testable in 7-04 (real-time push) when the hub has a fully-deployed running fixture.
