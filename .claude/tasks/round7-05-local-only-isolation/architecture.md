# Round 7-05 — Local-Only Concerns Isolation (Architecture)

`[Engineer-Principal · Opus · run-round7-05-local-only-isolation]`

## Problem statement

Round 7-02 introduced `HubClient` so the local Orbital can proxy state-shaped data
(tasks, channels, memory, audit events) to a central hub while keeping
resource-bound concerns (worker processes, cost ledger, replay blobs, capability
private keys, Anthropic API key) on the operator's laptop.

The split today is enforced by **convention only**. A future refactor — e.g.
adding a new field to `HubEventInput.payload`, or a new tRPC procedure that
accidentally accepts a cost ledger entry — could leak operator secrets into the
hub. There is no hard guarantee at compile time, no runtime guard, and no CI
check that would notice.

This task installs **three layers of defence** so the local-only contract holds
across refactors:

1. **Compile-time** — branded `LocalOnly<T>` type that the `hub-client` API
   refuses to accept. Any leak that flows through the type system trips `tsc`.
2. **Runtime** — sanitiser middleware on every outgoing hub request that walks
   the JSON payload, refuses requests containing well-known secret-shaped
   field names or values, and emits a CRITICAL alert event if it ever fires.
3. **CI** — static analysis script that runs on every PR, checking for type
   violations and grepping the source for sensitive literal patterns.

A leak in this codebase is a security incident — Anthropic key exfiltration,
replay-blob privacy breach, capability private key disclosure. We treat this
as Risk Tier High and commit to **defence in depth**.

## Bounded contexts touched

| Context | Files | Change |
|---|---|---|
| Type system | `packages/orchestrator/src/types/local-only.ts` (NEW) | Brand type + factory |
| Cost ledger | `packages/orchestrator/src/cost/types.ts` | Tag `CostLedgerEntry` rows as `LocalOnly` when read locally |
| Replay | `packages/orchestrator/src/replay/store.ts`, `replay/types.ts` | Tag `CaptureBody.request/response` as `LocalOnly` |
| Hub client | `packages/orchestrator/src/hub-client/sanitize.ts` (NEW), `client.ts` | Sanitise every outgoing request body |
| Events | `packages/orchestrator/src/events/store.ts` | Sanitise events before fanout to hub |
| UI | `packages/ui/src/components/features/settings/HubTab.tsx` | "Local-only data" panel |
| CI | `scripts/ci-leak-check.ts` (NEW), `.github/workflows/ci.yml` | Leak check job on every PR |

## Aggregate boundaries

No new aggregates. The marker type wraps existing aggregates' read shapes; the
sanitiser inspects but does not mutate request payloads.

## Event flow

| Step | Where | What |
|---|---|---|
| 1 | `EventStore.append()` | Local Postgres write (always) |
| 2 | `sanitizeForHub(payload)` | Reject if any sensitive pattern detected |
| 3 (rejected) | emit `LocalDataLeakDetected` event | written to local audit log; CRITICAL log line; metric incremented |
| 3 (clean) | `HubOutbox.enqueue()` | event proceeds to hub via outbox (Round 7-02) |
| 4 | `HubClient.events.append()` | sanitise once more at the wire boundary; throws `LocalDataLeakError` if anything slipped past |

The sanitiser runs **at two points** by design — at the events boundary
(Round 7-05) and at the wire boundary (every `HubClient.rpc` call). Defence in
depth: a future router that bypasses the events store still cannot reach the
hub without sanitising.

## IAM / capability diff

None. The sanitiser does not touch capabilities. The `LocalDataLeakDetected`
event reuses the existing `audit.events.append` capability; no new permissions.

## DSQL schema diff

None. No new tables. Local-only data already lives in local Postgres
(`cost_ledger`, `replay_captures`); this round does not modify schemas, only
adds runtime+compile-time enforcement that those rows do not flow to the hub.

## Blast radius

| Failure mode | Effect | Mitigation |
|---|---|---|
| Sanitiser rejects a legitimate payload | Hub event lost; local Postgres write still succeeds | Whitelist: payload field names only flagged if regex matches; a `description: "we use api_keys for auth"` text in a memory entry **value** would not match (only field-name patterns + key-prefix value matches). Plus reverse-engineering: a CRITICAL log lets the operator notice immediately. |
| Sanitiser misses a real leak | Anthropic key reaches hub | Defence in depth: type system + CI grep. CI grep scans for `sk-ant-` literal anywhere in `src/`. |
| Type marker subverted via `as` cast | Compile-time check defeated | CI grep also looks for `as LocalOnly` in non-`local-only.ts` files; warns. |
| Static analysis script slow | CI pipeline delay | Script reads files synchronously, no AST walk; <2s on this codebase. |
| New tRPC procedure forgets sanitiser | Bypass at the wire | Wire-boundary sanitiser is in `client.rpc()` itself, called by EVERY `HubClient` method. New procedures cannot bypass without modifying `client.ts` (visible in PR review). |

## Rollback strategy

If the sanitiser falsely rejects too many requests, set
`ORBITAL_LEAK_CHECK_MODE=warn` (NEW env var). In `warn` mode the sanitiser
still inspects and logs but does not throw, so requests proceed. Default is
`enforce`. CI grep can be disabled by setting `OBSERVATIONAL_ONLY=1` in the
workflow. Both should be temporary.

The marker type is a pure type-level construct with `as LocalOnly<T>` as the
producer — removing the markers does not break runtime behaviour, only loses
the compile-time check. So rollback is "delete imports of LocalOnly"; no
runtime migration needed.

## Acceptance criteria (mirrors round brief)

1. `LocalOnly<T>` type prevents any function in `hub-client/` from accepting it
   (compile-time check via type tests, `// @ts-expect-error`).
2. Runtime sanitiser: posting a fake Anthropic key in a hub event → blocked
   with `LocalDataLeakError`; alert event written; key NOT in hub Postgres.
3. CI leak-check: deliberately-broken code (Anthropic key in event payload)
   fails the CI check; non-zero exit.
4. Replay blob privacy: capturing a replay → metadata row in hub Postgres,
   blob body stays at `~/.orbital/replays/`. `replay_captures.storage_uri`
   row in hub DB shows `file:///` URI not blob bytes.
5. Cost ledger: `cost.ledger.append` writes ONLY locally; hub has zero
   `cost_ledger` rows for that entry.
6. Capability bundle private key never appears in hub Postgres.
7. Audit log on hub does not contain any string starting with `sk-ant-`.

## Persona evidence prefix

`[Engineer-Principal · Opus · run-round7-05-local-only-isolation]`

## Confidence

98 — type system + runtime + CI is a standard defence-in-depth pattern; risks
are well bounded; sanitiser is opt-in via env var if it misfires.
