# Round 7-03 — Federation Auth (Identity & Pairing)

## Persona / Risk
Engineer-Principal · Opus · Risk Tier: High · Estimate: M

(Risk High because cryptographic correctness — wrong = unauthorized cross-operator actions, signature replay, identity confusion.)

## Depends on
7-01 (hub deployable)

## Why
Each laptop has an Ed25519 keypair (existing `keys/` module). For multi-operator collaboration the hub must trust local installs by their public key, and every local-to-hub request must be signed and verifiable. Without this any laptop on the internet could mutate the hub.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `keys/` | existing | Reuse Ed25519 primitives. Add `signEnvelope(message, ttlMs)` and `verifyEnvelope(message, sig, knownPubkey)`. |
| NEW `hub/auth/` (server-side) | `hub/auth/{middleware.ts,registration.ts,known-installs.ts}` | Hub-side auth — validates signed envelopes, manages `known_installs` table |
| NEW `hub-client/auth.ts` | New | Local-side: signs every outgoing request |
| NEW `db/schema/known-installs.ts` | New | `known_installs(install_id, tenant_id, public_key, role, display_name, joined_at, last_seen_at, revoked_at)` — hub-only table |
| NEW `db/migrations/0029_known_installs.sql` | New | Schema + indexes |
| NEW `cli/orbital-join.ts` | New | CLI: `orbital join <invite-url>` — handles registration handshake |
| NEW `cli/orbital-invite.ts` | New | CLI (hub admin): `orbital invite create --role member` — generates invite token |
| `trpc/middleware/auth.ts` | existing or new | Hub mode: extracts signed envelope from headers, verifies via `known_installs.public_key`, injects `ctx.installId`, `ctx.tenantId`, `ctx.role` |

## Wire format
Every local-to-hub request carries:
```
X-Orbital-Install-Id:  <uuid>
X-Orbital-Sig:         <base64-ed25519-signature>
X-Orbital-Sig-Body:    <base64-canonical-json({method, params_hash, ts, nonce})>
```

Hub validates:
1. Decode `Sig-Body`, parse JSON.
2. `ts` within ±60s of server time (clock-drift tolerance).
3. `nonce` not seen in last 5min (replay window) — in-memory LRU.
4. `params_hash` matches sha256 of actual request body.
5. Verify Ed25519 sig against `known_installs[install_id].public_key`.
6. If `revoked_at IS NOT NULL` → 401 INSTALL_REVOKED.
7. Inject identity into ctx.

## Pairing flow (CLI + UI)
**Hub admin creates invite:**
```
$ orbital invite create --role member --hub https://orbital.team.dev
Invite URL: https://orbital.team.dev/join/eyJ0... (valid 24h, single-use)
```
The token is a JWT signed by the hub's master key, with claims `{tenant_id, role, expires_at, jti}`.

**Local install joins:**
```
$ orbital join https://orbital.team.dev/join/eyJ0...
Generating keypair... ✓
Sending registration request... ✓
Joined hub orbital.team.dev as member
Display name [matt-laptop]:
```
Local Orbital generates an Ed25519 keypair, stores in keychain (or fs encrypted), POSTs `/register` with `{install_id, public_key, display_name, invite_token}`. Hub validates token, inserts row into `known_installs`, returns `{ok, tenant_id, hub_pubkey}`.

## Roles
- `owner` — can invite, revoke, change tenant settings
- `member` — can claim tasks, post messages, file defects, run agents
- `viewer` — read-only (for stakeholders/PMs who don't run agents)

Capability checks throughout: scheduler claim requires `member` or `owner`; admin endpoints require `owner`.

## Frontend UX
### Settings → Team tab (NEW)
- This install: display name, install_id (short), public key fingerprint, role, joined date
- Hub: URL, status, hub fingerprint
- Members table (owners only): avatar, display name, role, last-seen, "Revoke" button
- Pairing: "Add member" button → modal with copy-able invite URL
- Key rotation: rare-use button "Rotate this install's key" with strong confirmation

### Welcome wizard (extend existing)
- New "Join a hub" step: paste invite URL or "Run solo (local-only)"
- Solo mode is the current default; joining is opt-in

## Acceptance criteria
1. `orbital invite create` produces a valid JWT-signed token; expires after 24h; single-use.
2. `orbital join` flow: generates keypair, registers with hub, persists install_id + privkey locally, never logs the privkey.
3. Hub `register` endpoint: rejects expired tokens, rejects reused tokens (jti tracked), accepts valid first-use, writes `known_installs` row.
4. Signed envelope middleware: requests with valid sig pass; invalid sig → 401 AUTH_SIG_INVALID; replayed nonce → 401 AUTH_REPLAY; expired ts → 401 AUTH_TS_EXPIRED.
5. Revoked install: subsequent requests → 401 INSTALL_REVOKED. UI shows "your install was revoked" banner with contact-admin instructions.
6. Two installs paired with one hub can both make authenticated requests; each gets its own `ctx.installId`.
7. Privkey never appears in any log line, any HTTP body, any audit event (CI text-search check).
8. Clock drift: laptop with 30s clock skew can still authenticate; laptop with 5min skew cannot.

## Hard-stop grep checks
```
grep -E "verifyEnvelope|signEnvelope" packages/orchestrator/src/keys/ -r
grep -E "known_installs" packages/orchestrator/src/db/schema/ -r
grep -E "INSTALL_REVOKED|AUTH_SIG_INVALID" packages/orchestrator/src/trpc/middleware/auth.ts
ls packages/orchestrator/src/cli/orbital-join.ts packages/orchestrator/src/cli/orbital-invite.ts
```

## Out of scope
- Multi-factor or hardware-key auth (Yubikey, WebAuthn) — Round 8+
- Session tokens / refresh — keys are long-lived; revocation on the hub is the kill switch
- Cross-hub federation (one operator's hub trusting another's hub) — Round 9+

## Persona evidence prefix
`[Engineer-Principal · Opus · run-round7-03-federation-auth]`
