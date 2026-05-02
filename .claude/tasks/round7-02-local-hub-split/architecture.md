# Round 7-02 — Local-vs-Hub Split in Local Orbital

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: L

## Depends on
7-01 (hub extracted)

## Why
Today the local Orbital is self-sufficient — its own scheduler, its own DB, its own router for everything. After 7-01 the hub holds the shared data. The local Orbital must now be a **thick client** that uses the hub for shared data and stays self-sufficient for local-only concerns.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| NEW `hub-client/` module | `hub-client/{client.ts,types.ts,subscriptions.ts,outbox.ts}` | HTTP+WS client that local routers proxy to |
| `trpc/routers/tasks.ts`, `sprints.ts`, `memory.ts`, `comms.ts`, `defects.ts`, `audit.ts`, `prs.ts` | existing | Replace local Postgres queries with calls to `hubClient.tasks.*` etc. These routers become proxies. |
| `trpc/routers/orchestration.ts` (workers, etc.) | existing | Stays local-only (workers spawn locally) |
| `trpc/routers/cost.ts` (Round 6 #5) | existing | Stays local-only |
| `trpc/routers/replay.ts` (Round 6 #7) | existing | Metadata proxied to hub; blob bodies stay local |
| `orchestration/scheduler.ts` | existing | Reads task list from hub, claims tasks via hub mutations, writes events via hub |
| `orchestration/spawn.ts` | existing | Worker registration writes to hub (other operators see workers); worker-output stream stays local |
| `mcp/middleware/audit.ts` | existing | Tool call events fan out to BOTH local store (for replay) AND hub (for cross-operator visibility) |
| `ws/hub.ts` | existing | Local UI subscribes to local events for local-only data; subscribes to hub WS for shared data |

## Two endpoints, one UI
The local Orbital UI uses ONE tRPC client today. After this task, it has two:
- `trpcLocal` — for cost, replay blobs, live worker stdout, local-spawn-controls
- `trpcHub` — for tasks, memory, channels, defects, audit, PRs, sprints

Convention: routers exposed by both endpoints get explicit prefix (`trpcLocal.workers.list`, `trpcHub.tasks.list`).

## What's preserved
Backwards compat: `ORBITAL_HUB_URL` unset → all routers default to local Postgres (legacy single-machine mode, 100% identical behaviour). The split only activates when a hub is configured.

## Frontend UX
- New status indicator in topbar: "Connected to hub: orbital.team.dev" with green/yellow/red dot
- "Disconnected" banner when hub WS drops
- Settings → Hub tab (NEW): hub URL config, status, last sync, "test connection" button

## Acceptance criteria
1. Local Orbital with `ORBITAL_HUB_URL` set: `tasks.list` query goes to hub (verify with mock hub fixture); response cached in local React Query.
2. Local Orbital without `ORBITAL_HUB_URL`: behaves identically to today (regression-clean).
3. Worker spawn: scheduler reads ready-tasks from hub; claim mutation goes to hub; spawned worker registers in hub's `agent_workers` and local `agent_workers` (dual-write for now; hub is canonical).
4. Tool call audit: every MCP tool call writes an event to local event store (for replay) AND to hub event store (for cross-operator visibility).
5. WS subscription: UI subscribes to hub WS for `tasks.*` events; receives them within 500ms of another operator's mutation.
6. Status indicator reflects hub connection state.

## Hard-stop grep checks
```
grep -rE "from '\.\./hub-client" packages/orchestrator/src/trpc/routers/ | wc -l    # should be ≥ 5
grep -E "hubClient" packages/orchestrator/src/orchestration/scheduler.ts
grep -E "hub-status|hubConnected" packages/ui/src/components/ -r | head
```

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round7-02-local-hub-split]`
