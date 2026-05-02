# Phase 1B — CBAC Core: Architecture

## Bounded Context

**Owns:** Capability issuance, signing, validation, revocation; the two-tier Ed25519 key hierarchy; the runtime gateway validation function used by the MCP gateway (Phase 2B); SoD enforcement at issue and validate time.

**Does not own:**
- Event store internals — depends on Phase 1A `EventStore.append(event)`.
- MCP gateway server — Phase 2B; we expose only `validateToolCall(bundle, toolName, params)`.
- Capability denial channel post — TRD-05 (Comms) consumes the `CapabilityDenied` event downstream.

## Aggregates

| Aggregate | Anchor | Mutations |
|---|---|---|
| `capability_grant` | `capability_id` (UUIDv7) | `issued` → `active` → (`expired` \| `revoked`) |
| `capability_denial` | `denial_id` | append-only |
| `capability_revocation` | `revocation_id` | append-only |
| `signing_key` (master, sub) | `key_id` | `active` → `retired` → `archived`; `compromised` is terminal |
| `key_history` | `history_id` | append-only |
| `capability_policy` | `policy_id` | one row per version; `deactivated_at` set on supersession |

## Files Created

```
packages/orchestrator/src/db/schema/capabilities.ts
packages/orchestrator/src/db/migrations/0002_capabilities.sql
packages/orchestrator/src/capabilities/keychain.ts
packages/orchestrator/src/capabilities/canonical-json.ts
packages/orchestrator/src/capabilities/keys.ts
packages/orchestrator/src/capabilities/bundle.ts
packages/orchestrator/src/capabilities/policy.ts
packages/orchestrator/src/capabilities/sod.ts
packages/orchestrator/src/capabilities/authority.ts
packages/orchestrator/src/capabilities/gateway.ts
config/capability-policy.default.ts
packages/orchestrator/test/unit/capabilities/keychain.test.ts
packages/orchestrator/test/unit/capabilities/bundle.test.ts
packages/orchestrator/test/unit/capabilities/authority.test.ts
packages/orchestrator/test/unit/capabilities/gateway.test.ts
packages/orchestrator/test/unit/capabilities/sod.test.ts
packages/orchestrator/test/integration/capabilities/lifecycle.integration.test.ts
```

## Event Flow

All events emitted via `EventStore.append(event)`.

```
issue() → CapabilityIssued (capability aggregate)
       → CapabilityGranted (capability aggregate, fine-grained matched-scope record)

validateToolCall() denial path:
       → CapabilityDenied (capability aggregate)

revoke() → CapabilityRevoked (capability aggregate)

KeyManager.generateMaster()  → KeyHistory(transition=generated)  + signing_keys row (no event for v0; master generation is a one-time bootstrap, recorded by key_history)
KeyManager.generateSubKey()  → KeyHistory(transition=signed_sub)
KeyManager.rotate()          → KeyRotated event
KeyManager.archive(keyId)    → KeyArchived event
```

Note: `gateway.validateToolCall()` returns the validation result synchronously without writing events — the caller (Phase 2B MCP gateway) is responsible for emitting `CapabilityDenied` on failure or `CapabilityGranted` on success. This keeps the gateway validation pure-functional and testable, while still providing the data needed for the event payload. Phase 2B is not yet built; this Phase 1B implementation also exposes a helper that emits the event so unit tests can verify the full flow without depending on Phase 2B.

## Two-Tier Key Hierarchy

```
master_key (Ed25519, generated at orbital init or test bootstrap)
  └── sprint_sub_key (Ed25519, generated per sprint at first issue() call)
        └── capability_bundle.signature  (Ed25519 over canonical JSON of bundle minus signature)
```

- Master private bytes: OS keychain (keytar service `orbital`, account = `master:{key_id}`).
- Sub-key private bytes: OS keychain (keytar service `orbital`, account = `sub:{key_id}`).
- Public bytes: `signing_keys` table.
- Master signs `H(sub_pub_key || sub.created_at || install_id || sprint_id)` to bind sub-key into chain. Stored on the `signing_keys.parent_signature` column.

## IAM / Keychain Diff

- New keychain entries in service `orbital`:
  - `master:{key_id}` — Ed25519 master private key (32 bytes, base64).
  - `sub:{key_id}` — Ed25519 sprint sub-key private (32 bytes, base64).
- Test mode: file-based shim at `~/.orbital-test-keychain.json`, mode 0600. Behind `ORBITAL_TEST_KEYCHAIN=1` env flag. Production code path uses `keytar`.
- Zeroization at +30 days deletes the keychain entry. Postgres row retains `keychain_ref=null` and `private_zeroized_at=<timestamp>`.

## DSQL / Postgres Schema Diff

Six new tables in migration `0002_capabilities.sql`:
- `capability_grants` — every issued bundle's metadata
- `capability_denials` — every rejected tool call (audit forensics)
- `capability_revocations` — explicit and emergency revocations
- `signing_keys` — master + sub-key public components and metadata
- `key_history` — append-only audit of key transitions
- `capability_policies` — runtime form of the policy TS config

Append-only constraint: triggers on `capability_grants`, `capability_denials`, `capability_revocations`, `key_history` reject UPDATE and DELETE. The `status` column on `capability_grants` is mutated only by an explicit stored procedure (omitted for v1 — TRD-06 §8 anticipates this for v2; v1 status is set at insert time and not mutated by validators; the validator reads `now() vs expires_at` for liveness rather than checking row status).

## Blast Radius

If `validateToolCall()` fails-open or accepts a forged bundle, every worker tool call is compromised. Mitigations:
- Public-key cache populated only from rows we wrote ourselves.
- Signature verification is constant-time via `@noble/ed25519.verifyAsync`.
- Bundle JSON is canonicalized before verification; any whitespace tampering invalidates the signature.
- Wildcards in `secrets` rejected at policy compile AND at validator (defense in depth).
- `PATH_HARD_DENY` constant trips even if policy authoring is buggy.

If keychain compromised:
- Master: emergency rotation per TRD-06 §11.2 (out of scope for Phase 1B; the helper `KeyManager.rotate()` only handles scheduled sub-key rotation — emergency rotation is a future story).
- Sub: bounded blast radius — only the current sprint's bundles. Mass-revoke + new sub-key generation.

## Rollback Strategy

- Migration is purely additive (six new tables). To roll back: drop the six tables in reverse-dependency order, no data lost in other systems.
- Module deletion: removing `packages/orchestrator/src/capabilities/` is safe before Phase 2B; no other module imports it yet.
- Keychain entries: a `keys.purge --test-only` operation (test helper) removes shim entries; production keytar entries remain unless explicitly removed.

## Confidence

`confidence: 92` — High because TRD-06 fully specifies the data model, validation algorithm, and SoD rules. The 8-point gap is Phase 1A coupling (we depend on EventStore.append being callable; the interface is fixed but the file may not exist when tests are first written; tests will reference the real path and pass once 1A lands).

## Phase 1A Interface Assumption

```typescript
// We assume Phase 1A exposes from packages/orchestrator/src/events/store.ts:
export interface EventStore {
  append(event: EventInput): Promise<EventEnvelope>
  query(filter: EventQueryFilter): Promise<PaginatedResponse<EventEnvelope>>
  subscribe(cursor: string | null, handler: (e: EventEnvelope) => void): () => void
}

export class EventStoreImpl implements EventStore { /* uses db client */ }

// OR a default-instantiated `eventStore` export.
```

Our code imports the type from `../events/store.js` and the constructor or default instance. If Phase 1A renames the file or the symbol, we update one import path here. To keep Phase 1B testable in the interim, our tests construct a thin `InMemoryEventStore` adapter implementing the same contract for unit tests; integration tests use the real implementation when it lands.

## SoD Rules (v1)

Encoded in `config/capability-policy.default.ts` and enforced in `sod.ts`:

1. `sod_dev_no_approve` — developer personas cannot have `board_mutate` patterns matching `*.approval_status` or `*.review_decision`.
2. `sod_verifier_no_artifact_write` — verifier persona's `files_write` MUST be empty AND verification target paths MUST NOT overlap with verifier's `files_read` patterns acting as a write.
3. `sod_no_self_revocation` — no persona may have `board_mutate: capability:*`.
4. `sod_retro_no_apply` — retro persona cannot have `files_write: config/**`.
5. `sod_ceremony_chair_not_participant` — task-derived: the persona granted `ceremony_role: ['chair']` must not also be in the participants list of the same ceremony (passed in as `verification_target` analogue — `ceremony_target`).

Issue-time: `CapabilityAuthority.issue()` calls `sod.checkIssue(personaId, scopes, taskContext)` and returns `AUTH_SOD_VIOLATION` before signing if any rule fires.
Runtime: `gateway.validateToolCall()` calls `sod.checkRuntime(bundle, tool, params)` (Step H) — same rules but parameterized on the requested action. The verifier-no-artifact-write rule is the canonical runtime-only check.

## TDD Plan

1. Red: `keychain.test.ts` — file shim writes/reads/deletes; mode 0600 enforced.
2. Red: `bundle.test.ts` — sign/verify round-trip, tampered bundle rejected, expired rejected.
3. Red: `authority.test.ts` — issue creates row + emits both events; revoke writes row + emits event; SoD violation rejects.
4. Red: `gateway.test.ts` — file glob match, channel wildcard match, network egress hostname pattern, secrets exact match, secrets wildcard rejected, PATH_HARD_DENY trip.
5. Red: `sod.test.ts` — verifier write rejected, ceremony-chair-as-participant rejected, dev approval rejected.
6. Green: implement modules in dependency order: keychain → canonical-json → keys → bundle → policy → sod → authority → gateway.
7. Refactor: extract pattern-matching helpers, ensure 0 console logs.
8. Integration: `lifecycle.integration.test.ts` — issue → validate → revoke → validate fails. Real DB, real shim keychain, real Ed25519.
