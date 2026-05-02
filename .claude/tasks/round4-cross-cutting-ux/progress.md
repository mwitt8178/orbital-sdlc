# Round 4 — Fix WS Reconnect Loop + React Render Warning

run-id: round4-ws-react-fix

## Status: COMPLETE

## Bugs addressed

### Bug 1: WebSocket reconnect loop

Root cause: `scheduleReconnect()` in `services/ws.ts` captured the Zustand store state
snapshot BEFORE calling `incrementReconnectAttempts()`, then passed the stale
`conn.reconnectAttempts` (pre-increment value) to `computeBackoff()`. This caused
`computeBackoff` to always receive `0` on the first failure (backoff = 1000ms, constant),
making the reconnect cadence rapid rather than exponential.

Auth gate analysis: `ws/server.ts` preValidation already has the correct dev-mode bypass
(`if (!options.token) return`) and `index.ts` passes `token` only when `WS_SESSION_TOKEN`
is set. The auth gate was NOT the source of the reconnect loop. No changes to `ws/server.ts`
or `index.ts` were needed.

Fix: read `reconnectAttempts` from a fresh `getState()` call AFTER the increment:
```ts
useConnectionStore.getState().setStatus('reconnecting')
useConnectionStore.getState().incrementReconnectAttempts()
const attempts = useConnectionStore.getState().reconnectAttempts  // fresh read
const delay = computeBackoff(attempts)
```

Also added `console.warn` to `close` and `error` event handlers in dev to surface
the actual close code/reason when debugging connectivity.

### Bug 2: React render warning on /welcome

Root cause: `SetupGate` rendered `<Navigate to="/welcome" replace ... />` which calls
`navigate()` synchronously during render, triggering the React warning
"Cannot update a component (BrowserRouter) while rendering a different component (Welcome)".

Fix: replaced `<Navigate>` with `useEffect` + `useNavigate()` so the navigation fires
after the component commits, not during render. Rendered `<FullScreenLoader>` instead
during the brief window before the effect fires (avoids dashboard flash).

## Self-checks

- [x] Auth gate unchanged: dev-mode bypass (`!options.token => return`) preserved
- [x] Prod mode auth gate unchanged: requires token when `WS_SESSION_TOKEN` is set
- [x] All 5 WS auth tests pass (ws-auth.integration.test.ts)
- [x] Full unit + security integration suite: 741 tests pass
- [x] TypeScript: zero errors in modified files (`App.tsx`, `services/ws.ts`)
- [x] Build errors in `channels/MentionAutocomplete.tsx` and `channels/PresenceRow.tsx`
  are pre-existing from the channels parallel agent — NOT caused by this work
- [x] Did not touch any file owned by other parallel agents
  - channels/*, ceremonies/*, vision/*, uat/*, ui/Toast.tsx, CommandPalette.tsx,
    settings, audit/*, packages/orchestrator/src/index.ts
- [x] Multi-tenant: no tenant-scoped data touched (this is a connection/routing concern)
- [x] No new dependencies introduced

## Files modified

- packages/ui/src/services/ws.ts — backoff stale-read fix + logging
- packages/ui/src/App.tsx — SetupGate navigate-in-render → useEffect pattern

## Deferred

- The exact WS connection state in the running preview cannot be verified via
  automated tests without a live orchestrator on :3030. The logic fix (stale
  backoff read) is correct and the auth gate confirmed open in dev mode.
- channels/MentionAutocomplete.tsx and channels/PresenceRow.tsx build errors
  will be resolved by the channels agent; they are out of scope.
