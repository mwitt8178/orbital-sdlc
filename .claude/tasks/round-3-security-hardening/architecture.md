# Round 3 Security Hardening — Architecture

**Engineer-Principal · Opus**
**Risk Tier:** High (security-critical: WS auth, CORS, helmet, idempotency)
**Estimate:** XL
**Confidence:** 96 — narrow scope, additive changes, well-defined gaps with test coverage required for each.

---

## Bounded contexts touched

1. **Transport boundary** (Fastify HTTP + WS) — security headers, CORS allowlist, 404 envelope, WS auth gate
2. **Idempotency boundary** (tRPC mutation envelope) — new middleware + DB table to dedupe retries
3. **Observability boundary** (pino logger) — expanded redact paths
4. **Configuration boundary** (env schema) — two new vars: CORS_ALLOWED_ORIGINS, WS_SESSION_TOKEN

## Aggregate boundaries

- **No new aggregates.** Idempotency middleware uses a *non-event* table (`audit.mutation_idempotency`) — this is a transport-level dedupe cache, not an event aggregate. It does NOT replace EventStore.append; it sits in front of it so the same logical mutation is not re-appended.
- WS auth touches no aggregate; it's a connection-time gate.

## Event flow

No new events emitted. The idempotency middleware caches the *response* of a mutation; if the original mutation appended events, those events are NOT re-appended on retry — the cached response is returned. This is the correct semantic: a retry of `POST /sprint.start` with the same Idempotency-Key should not produce two `SprintStarted` events.

## IAM diff

- WS upgrade now requires either:
  - Header `x-orbital-ws-token: <token>`
  - Or query `?token=<token>`
- Token validated against env `WS_SESSION_TOKEN` (v1 simple). Future v2 can move to the keychain. In dev (`NODE_ENV=development`) with no token configured, connections are open with a clear boot warning.
- On rejection: WS close code 1008 (policy violation), reason `AUTH_INVALID_WS_TOKEN`.

## DSQL schema diff

New table — see `0014_idempotency.sql`:

```sql
CREATE TABLE audit.mutation_idempotency (
  idempotency_key  text         NOT NULL,
  route            text         NOT NULL,
  response_json    jsonb        NOT NULL,
  status           text         NOT NULL,        -- 'success' | 'error'
  created_at       timestamptz  NOT NULL,
  expires_at       timestamptz  NOT NULL,
  PRIMARY KEY (idempotency_key, route)
);

CREATE INDEX mutation_idempotency_expires_at ON audit.mutation_idempotency (expires_at);
```

DSQL constraints respected:
- No FK
- No trigger
- No SERIAL — composite PK on (idempotency_key, route) is application-supplied text
- No materialized view
- TTL via `expires_at` column; periodic cleanup is a future ops task

OCC retry: writes are simple `INSERT ... ON CONFLICT DO NOTHING` so concurrent retries collapse safely.

## Blast radius

- **CORS misconfig:** Worst case — production browsers blocked. We default to a clear warning if `CORS_ALLOWED_ORIGINS` is empty in production, so misconfig is loud.
- **Helmet:** Default policies are strict; CSP relaxed in dev for Vite HMR. If a directive is too tight, individual routes may break — mitigated by integration test exercising representative routes.
- **404 envelope:** Cannot break existing routes (additive); covers only previously-unhandled paths.
- **WS auth:** Tightens. Existing UI clients must add the header. Dev mode (no token configured) keeps existing dev experience but logs a clear warning.
- **Idempotency middleware:** Adds one small SELECT + INSERT around mutations. Latency budget: <2ms. If the table is unreachable, we fail open (log + proceed) — explicit choice; we'd rather process a possibly-duplicate mutation than reject all writes.
- **Pino redact:** Strictly additive. Worst case logs become slightly noisier with `[REDACTED]` placeholders.

## Rollback strategy

Each gap is in its own commit/file. If S5 (idempotency) misbehaves in canary, we revert just `trpc/init.ts` to remove the middleware wrapping; the table can stay (no FK referencing it). All other gaps are pure config/middleware additions; flipping a single line restores prior behavior.

For the migration: dropping `audit.mutation_idempotency` is non-destructive (no FK in or out).

## Cross-family review

This work is owned by Engineer-Principal (Opus). Code review will be dispatched to a non-Opus family per Hard Rule #2. Tests written first per TDD loop.

## Done criteria

1. All 6 gaps closed; each has at least one passing test
2. `npm run build` clean across orchestrator + ui + types workspaces
3. No regression in existing test suite
4. Idempotency middleware demonstrated on at least one mutation end-to-end
5. Wiring snippets surfaced for parallel agents owning `trpc/init.ts` adoption
