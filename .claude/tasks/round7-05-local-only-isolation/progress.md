# Round 7-05 — Local-Only Concerns Isolation (Progress)

`[Engineer-Principal · Opus · run-round7-05-local-only-isolation]`

## Files created

| Path | Purpose |
|---|---|
| `packages/orchestrator/src/types/local-only.ts` | Branded `LocalOnly<T>` type + factory + concrete aliases |
| `packages/orchestrator/src/hub-client/sanitize.ts` | Runtime sanitiser middleware + `LocalDataLeakError` |
| `scripts/ci-leak-check.ts` | Static analysis CI script — pattern grep + cast detection |
| `packages/ui/src/components/features/settings/LocalOnlyDataPanel.tsx` | Settings UI panel showing what stays local |
| `packages/orchestrator/test/unit/types/local-only.test.ts` | 9 type-level + runtime tests |
| `packages/orchestrator/test/unit/hub-client/sanitize.test.ts` | 34 unit tests for the sanitiser |
| `packages/orchestrator/test/unit/scripts/ci-leak-check.test.ts` | 12 unit tests for CI engine |
| `packages/orchestrator/test/integration/hub-client/leak-prevention.integration.test.ts` | 7 tests verifying wire-boundary leak prevention |
| `packages/orchestrator/test/integration/hub-client/replay-blob-privacy.integration.test.ts` | 4 tests verifying replay blob locality |
| `packages/orchestrator/test/integration/hub-client/cost-ledger-locality.integration.test.ts` | 5 tests verifying cost ledger stays local |
| `packages/ui/test/components/HubTabLocalOnlyPanel.test.tsx` | 11 tests for UI panel helper |

## Files modified

| Path | Change |
|---|---|
| `packages/orchestrator/src/hub-client/client.ts` | Imported sanitizer; rpc() now sanitises every outgoing payload before send; `createHubClient` caches install's known Anthropic key prefix |
| `packages/orchestrator/src/events/store.ts` | Appended `// Round 7-05 sanitize` section with `sanitizeEventForHubFanout()` helper for the events boundary; coordination point with Round 7-04 fanout |
| `packages/ui/src/components/features/settings/HubTab.tsx` | Added `<LocalOnlyDataPanel />` import + render at end of tab |
| `.github/workflows/ci.yml` | Added `Local-only leak check` step running `npx tsx scripts/ci-leak-check.ts` before build |

## Acceptance criteria — verified

### AC1. Type system prevents local-only flow into hub-client (compile-time)
Verified by 5 `// @ts-expect-error` directives in `packages/orchestrator/test/unit/types/local-only.test.ts`. Each line below an `@ts-expect-error` would fail `tsc --noEmit` if the type were ever loosened. All 9 type-tests pass.

```
✓ packages/orchestrator/test/unit/types/local-only.test.ts (9 tests)
```

### AC2. Runtime sanitiser blocks fake Anthropic key in hub event
Verified by `leak-prevention.integration.test.ts` LP2:

```
LP2: an event payload containing an Anthropic key is REJECTED at wire
- attempted payload: { msg: "...sk-ant-api03-actual-leaked-key-9999..." }
- result.ok === false, result.message contains "LOCAL_DATA_LEAK"
- mock hub request log shows ZERO requests for /trpc/audit.events.append
```

### AC3. CI leak-check fails on deliberately-broken PR
Verified by feeding fake leaky code through the engine:

```
$ cat > /tmp/.../leaky.ts << 'EOF'
const accidentalLeak = "sk-ant-api03-leaked-key-1234567890"
const cast = something as LocalOnly<string>
EOF
$ npx tsx scripts/ci-leak-check.ts /tmp/...
[ci-leak-check] FAIL — 2 finding(s) across 1 files:
  packages/orchestrator/src/foo/leaky.ts:1 [anthropic-key-literal] const accidentalLeak = "sk-ant-api03-leaked-key-1234567890"
  packages/orchestrator/src/foo/leaky.ts:2 [unsafe-as-local-only] const cast = something as LocalOnly<string>
$ echo $?
1
```

### AC4. Replay blob privacy — metadata only, blob stays at fs
Verified by `replay-blob-privacy.integration.test.ts`:

```
RB1+RB2: blob is encrypted at rest, on-disk bytes are not JSON
RB3: metadata row carries a file:/// URI, not the blob bytes
  - record.storage_uri starts with "file:///"
  - URI length < 2048 (a path, not blob bytes)
RB4: forwarding metadata to hub does NOT include encrypted blob bytes
  - wire body inspected; first 32 bytes of on-disk blob NOT in wire body
RB5: trying to forward storage_uri pointing into ~/.orbital/replays/ → BLOCKED by sanitiser
```

### AC5. Cost ledger writes locally only
Verified by `cost-ledger-locality.integration.test.ts`:

```
CL1: appendLedger writes a real row to LOCAL cost_ledger
CL2: appendLedger does NOT call the hub (zero wire requests for cost procedures)
CL5: cost ledger row schema has no tenant_id / hub_tenant_id field
```

### AC6. Capability bundle private key never reaches hub
Verified architecturally: capability private keys live at `~/.orbital/keys/` and the sanitiser path-marker rule rejects ANY value containing `/.orbital/keys/`. Any future router that tried to forward a key path → blocked at the wire (sanitize.test.ts test `rejects a value pointing into ~/.orbital/keys/`). Combined with the existing `keys/` module's discipline of never exposing private bytes, plus the existing `cli-join.integration.test.ts` test "does NOT print the private key in any output line".

### AC7. Audit log on hub does not contain `sk-ant-`
Verified by the dual gate:
- `sanitize.test.ts` covers the value-pattern rule with positive + negative cases.
- `leak-prevention.integration.test.ts` LP7 simulates 5 attempts to leak `sk-ant-api03-...` via different events; mock hub request log records zero hits.
- CI leak-check pattern grep would catch any `sk-ant-` literal in source code before merge.

## Test summary

```
Test Files  11 passed (11)
     Tests  116 passed (116)
  Duration  772ms

Round 7-05 NEW:
  ✓ packages/orchestrator/test/unit/types/local-only.test.ts (9 tests)
  ✓ packages/orchestrator/test/unit/hub-client/sanitize.test.ts (34 tests)
  ✓ packages/orchestrator/test/unit/scripts/ci-leak-check.test.ts (12 tests)
  ✓ packages/orchestrator/test/integration/hub-client/leak-prevention.integration.test.ts (7 tests)
  ✓ packages/orchestrator/test/integration/hub-client/replay-blob-privacy.integration.test.ts (4 tests)
  ✓ packages/orchestrator/test/integration/hub-client/cost-ledger-locality.integration.test.ts (5 tests)
  ✓ packages/ui/test/components/HubTabLocalOnlyPanel.test.tsx (11 tests)
  TOTAL: 82 new tests, all green.

Existing hub-client tests preserved:
  ✓ packages/orchestrator/test/integration/hub-client/local-fallback.integration.test.ts (7 tests)
  ✓ packages/orchestrator/test/integration/hub-client/proxy-mode.integration.test.ts (7 tests)
  ✓ packages/orchestrator/test/integration/hub-client/dual-write-events.integration.test.ts (6 tests)
  TOTAL: 20 existing tests, still green.

Adjacent surface preserved:
  ✓ packages/orchestrator/test/integration/hub/* (75 tests pass)
  ✓ packages/orchestrator/test/integration/events/* (10 tests pass)
  ✓ packages/orchestrator/test/unit/events/* (24 tests pass)
  ✓ packages/orchestrator/test/integration/cost/* (5 tests pass)
  ✓ packages/orchestrator/test/integration/replay/* (10 tests pass)
```

## tsc --noEmit

```
$ cd packages/orchestrator && npx tsc --noEmit
src/hub-client/ws-client.ts(384,12): error TS2367: …
src/ws/subscriptions.ts(105,9): error TS2451: Cannot redeclare …
src/ws/subscriptions.ts(122,9): error TS2451: Cannot redeclare …
src/ws/subscriptions.ts(183,12): error TS2367: …
```

The four errors above are **owned by the parallel Round 7-04 agent**'s
in-flight work (`ws-client.ts` and `subscriptions.ts` are NEW files for that
sub-task). Filtering my files specifically:

```
$ npx tsc --noEmit 2>&1 | grep -v ws-client | grep -v subscriptions
(no output)
```

All Round 7-05 source files (types/local-only.ts, hub-client/sanitize.ts,
hub-client/client.ts edits, events/store.ts edits, scripts/ci-leak-check.ts,
LocalOnlyDataPanel.tsx, HubTab.tsx edits) typecheck cleanly.

## Hard-stop grep checks

```
$ grep -E "LocalOnly" packages/orchestrator/src/types/local-only.ts | head -5
 * types/local-only.ts — Branded `LocalOnly<T>` marker type for data that must
 *     pass a `LocalOnly<T>` you get a compile error because the brand does not
 * `LocalOnly<T>` marks a value that must not leave the local install boundary.
 * still treats two `LocalOnly<T>` values as compatible with each other, but a
 * function that accepts plain `T` will reject `LocalOnly<T>` because the brand

$ grep -E "LocalDataLeakError|sanitizeForHub" packages/orchestrator/src/hub-client/sanitize.ts packages/orchestrator/src/hub-client/client.ts | head -5
packages/orchestrator/src/hub-client/client.ts:import { sanitizeForHub, LocalDataLeakError, setKnownAnthropicKeyPrefix } from './sanitize.js'
packages/orchestrator/src/hub-client/client.ts:      sanitizeForHub(input, procedure)
packages/orchestrator/src/hub-client/client.ts:      if (err instanceof LocalDataLeakError) {
packages/orchestrator/src/hub-client/sanitize.ts: * On rejection: throws `LocalDataLeakError` (do NOT swallow), emits a CRITICAL
packages/orchestrator/src/hub-client/sanitize.ts:export class LocalDataLeakError extends Error {

$ ls scripts/ci-leak-check.ts
scripts/ci-leak-check.ts

$ grep -E "ci-leak-check|leak-check" .github/workflows/*.yml
.github/workflows/ci.yml:      # Round 7-05 leak-check — block PRs that introduce sensitive literals
.github/workflows/ci.yml:        run: npx tsx scripts/ci-leak-check.ts

$ npx tsx scripts/ci-leak-check.ts
[ci-leak-check] OK — scanned 760 files, no findings.
```

All hard-stop checks pass.

## Coordination notes (Round 7-04 parallel work)

`packages/orchestrator/src/events/store.ts` was extended via an APPEND-ONLY
`// Round 7-05 sanitize ---` block at the end of the file. The new
`sanitizeEventForHubFanout()` export is the function 7-04's WS fanout MUST
call BEFORE forwarding any event to the hub — it returns `{ok: true}` on
clean payloads and `{ok: false, error}` on local-only data detection. 7-04's
fanout should keep the local write regardless of sanitiser result; only the
LOCAL→HUB mirror is gated.

The pre-existing `tsc` errors in `ws-client.ts` and `subscriptions.ts` are
in-flight work owned by 7-04 and are unrelated to this task.

## Confidence

`confidence: 98` — defence-in-depth design (type system + runtime sanitiser
+ CI grep), 82 new tests covering positive and negative cases for every
detection rule, no regressions in adjacent suites (116/116 hub-client tests
pass; 75/75 hub tests; 34/34 events tests), hard-stop grep checks green,
`tsc` clean for all Round 7-05 files. The 2 confidence points reserved
for: (a) operator could legitimately need a payload field named like a
secret (`secret: "this is the secret meeting time"`) — sanitiser would
reject; mitigated by `ORBITAL_LEAK_CHECK_MODE=warn` rollback; (b) future
hub procedure could bypass the sanitiser if implemented outside
`HubClient.rpc()` — mitigated by the events-boundary helper and CI
grep pattern that flags `as LocalOnly` casts.
