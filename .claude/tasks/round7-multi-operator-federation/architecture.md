# Round 7 — Centralized Hub for Multi-Operator Collaboration

**Goal:** Both Ricky and Matt run their own local Orbital instances on their own laptops, but share **one central data plane** so it feels like one team. Like Linear or Notion: each person has a thick client connected to a shared backend; data is one source of truth; mutations sync in real time.

## Why this design (vs. third-party federation)

A previous draft of Round 7 leaned on Monday + GitHub + Slack as the federation substrate. That works for artifacts that already live in third parties (tickets, PRs, code) but is broken for Orbital's own data — project memory, defects, agent activity, audit events, channels — which would otherwise live in two separate Postgres databases that drift.

The right answer is the same shape every collaboration tool uses: **one shared backend, many connected clients.**

## What stays local vs. what moves to the hub

| Stays on each operator's laptop | Moves to the central hub |
|---|---|
| Spawning the `claude` binary (eats local CPU/RAM) | Task list / sprint board (`tasks`, `sprints`, `task_dependencies`) |
| Worktrees on disk (`orchestration/worktree.ts`) | Project memory (`project_memory_*`, Round 6 #4) |
| MCP gateway over Unix socket (`mcp/server.ts`) | Channels & messages (`comms/`) |
| Operator's own Anthropic key | Defects (Round 6 #3) |
| Local LLM cost ledger for that operator's spend (Round 6 #5) | Audit / event store (`events`) |
| Capability bundle signing (private keys never leave) | Identity registry (known_installs, federation pubkeys) |
| Replay blobs from this operator's runs (Round 6 #7) | Sprint plans, retros |
| Live worker process inspection (Round 6 #10 stays local-first) | PR linkage state (already shared via GitHub but mirrored here for unified view) |

The split is principled: **resource-bound stays local, knowledge-bound moves central.** Each operator pays for their own AI tokens and their own compute. The team's data is shared.

## Architecture diagram (logical)

```
                  +────────────────────+
                  │       HUB          │
                  │  orbital.team.dev  │
                  │  - Postgres        │
                  │  - WS hub          │
                  │  - Auth (PKI)      │
                  │  - Fastify         │
                  +─────────▲──────────+
                            │
                  WSS + JSON-RPC mutations
                  with operator-signed
                  request envelopes
                            │
                ┌───────────┴───────────┐
                │                       │
       +────────┴────────+    +─────────┴────────+
       │  matt's laptop  │    │ ricky's laptop   │
       │                 │    │                  │
       │  Local Orbital  │    │  Local Orbital   │
       │  - spawn.ts     │    │  - spawn.ts      │
       │  - worktrees/   │    │  - worktrees/    │
       │  - mcp gateway  │    │  - mcp gateway   │
       │  - keys/        │    │  - keys/         │
       │  - cost ledger  │    │  - cost ledger   │
       │  - replay blobs │    │  - replay blobs  │
       │                 │    │                  │
       │  UI: thick      │    │  UI: thick       │
       │  client to hub  │    │  client to hub   │
       +─────────────────+    +──────────────────+

       Workers spawned by Matt's local Orbital connect to
       Matt's MCP gateway (still local). Tool calls write
       events to the hub via the gateway's outbound WS.
```

## How the data flow works

### Read path
- Matt opens his UI → tRPC client connects to **hub** (not local orchestrator) for shared data — tasks, channels, memory, events.
- Local-only data (his cost ledger, his replay blobs, his live worker stdout) still queries his local orchestrator.
- The UI is one app talking to two endpoints — hub for shared, local for local.

### Write path (mutations)
- Operator UI fires `tasks.claim({task_id})` → hits hub directly with operator-signed envelope.
- Hub validates signature against `known_installs.public_key`, applies mutation, writes event, fans out to subscribed WS clients.
- Both UIs (Matt's and Ricky's) receive the new event in real time.

### Worker spawning
- Matt clicks "Run task" → his local orchestrator's scheduler picks it up → spawns worker locally → worker runs claude binary on Matt's laptop with Matt's API key.
- Worker's tool calls go to local MCP gateway, which forwards events to the hub. So Ricky sees "matt's sr-dev called Edit on src/foo.ts" live in his Inspection page.
- Cost ledger entries from Matt's worker → written to **Matt's local cost ledger**, not the hub. Ricky's UI shows aggregate "team cost" if he has permission, but Matt's individual spend isn't his to see.

## Identity & auth

Each laptop has a long-lived Ed25519 keypair (already in `keys/`). Pairing flow:

1. Hub admin (one operator) creates an invite token: `orbital invite create --role member`.
2. New operator runs `orbital join <invite-url>` on their laptop. Local Orbital generates keypair, sends `register` request signed with token + new pubkey.
3. Hub records `known_installs(install_id, pubkey, role, joined_at)`.
4. From then on, every request from that laptop to the hub carries an Ed25519 signature over `{method, params, timestamp, nonce}`. Hub verifies before applying.

This is **standard PKI**, not anything bespoke. Existing `keys/` module + a thin auth middleware on the hub.

## Real-time push

WS subscription model on the hub:
- `subscribe:task:<id>` — task state changes
- `subscribe:channel:<name>` — channel messages
- `subscribe:worker:<install_id>:*` — agents owned by this install (so Matt can show "ricky's agents" filterable view)
- `subscribe:project:<id>:events` — full audit stream for this project (with operator filtering)

Today's local WS hub (`ws/hub.ts`) becomes the hub's WS hub — same code, just running in the hub's process. Local Orbital subscribes to it.

## Offline handling

Realistic operator experience when network drops:
- **Already-running local workers continue.** They're using local resources, local MCP gateway. They emit events to a local outbox.
- **UI shows "Disconnected from hub" banner.** Cached state from last sync remains browseable. Mutations that target the hub are queued.
- **Reconnect:** outbox flushes events to hub in order. Hub deduplicates by event_id. Queued mutations submit. UI re-syncs.

Last-writer-wins on conflict for v1. Memory entry edited by both at once → whoever arrived at the hub second wins, with a "your edit was overridden by [matt's-orbital]" notification. CRDT-style merge can wait for v2 if anyone actually hits this.

## Local-only concerns isolation

Some things must NEVER leak from local to hub:
- **Anthropic API key** — stays in operator's `~/.orbital/config/install.json`, never sent to hub. Workers spawn locally, call Anthropic directly with their operator's key.
- **Replay blob content** — the metadata row goes to hub (so audits can see "a capture exists for event X"), but the encrypted blob stays on the operator's laptop. If Ricky needs to replay Matt's run, he requests the blob over a peer-to-peer channel mediated by the hub (capability check on the hub).
- **Capability bundle private keys** — bundle signing happens locally; hub only sees the signature.
- **Cost ledger detail** — line-by-line cost is each operator's private business. Aggregates ("team spent $X this sprint") go to hub if the operator opts in.

The principle: hub holds **state and signaling**, never **secrets or compute artifacts**.

## Sub-task breakdown

### 7-01: Extract orchestrator core into a deployable hub service
**Risk: Medium · Estimate: L · Engineer-Sr**
Take the existing orchestrator package and extract a "hub mode" startup. Same Fastify server, same tRPC routers, same Drizzle schema — but configured to run as a multi-tenant hub. Add tenant scoping (`hub_tenant_id` column) on shared tables. Boot config: `ORBITAL_MODE=local|hub`.

### 7-02: Local-vs-hub split in the local Orbital
**Risk: Medium · Estimate: L · Engineer-Sr**
The local orchestrator stops being self-sufficient for shared data. Routers that used to query local Postgres now proxy to the hub via a `HubClient`. Local-only routers (workers, cost-self, replay-blobs) stay local. The UI's tRPC client targets hub for shared, local for local.

### 7-03: Auth + identity registration (federation keys)
**Risk: High · Estimate: M · Engineer-Principal (security-critical)**
Pairing flow, signed-envelope middleware on hub, key rotation, revocation. Reuses `keys/` for primitives. `known_installs` table on hub.

### 7-04: Real-time push from hub to clients
**Risk: Medium · Estimate: M · Engineer-Sr**
Hub's WS server broadcasts events to subscribed clients. Replaces local-only WS today. Sticky-session-friendly: if one hub replica goes down, clients reconnect to another.

### 7-05: Local-only concerns isolation
**Risk: Medium · Estimate: M · Engineer-Sr**
Audit every existing data write to confirm: which goes to hub, which stays local. Anthropic key, cost line items, replay blob bodies, capability private keys all stay local. Add explicit `LocalOnlyData` markers in code; CI check that local-only types are never shipped to hub APIs.

### 7-06: Offline cache + reconciliation
**Risk: Medium · Estimate: L · Engineer-Sr**
Local outbox for events when hub unreachable. Reconnect → flush in order with idempotency. UI cached state via React Query persistence. "Disconnected" banner.

### 7-07: Hub deployment + ops
**Risk: Low · Estimate: M · Engineer-Sr**
Dockerfile for hub mode, docker-compose for self-host (hub + Postgres + minimal admin UI). `npm run hub:up` script. Backup/restore. Deployment guide in `docs/`.

### 7-08: Operator-attributed UI (the visible payoff)
**Risk: Low · Estimate: M · Engineer-Sr**
Every artifact in the UI shows the operator who created/last-touched it. Filter chips: "Mine" / "All operators". Inspection page (Round 6 #10) shows both fleets side-by-side. PR review comments display operator badge.

## Frontend UX changes

### Settings → "Team" tab (NEW)
- This install's identity (display name, public key fingerprint, role)
- Hub connection: URL, status (connected/disconnected/reconnecting), last sync
- Pairing: paste invite URL → join wizard
- Member list: avatars, roles, last-seen, "remove member" for owners
- Federation key rotation (rare; logged)

### Dashboard
- "Team" panel with member presence (online/offline/last-seen)
- Cross-operator activity feed: "ricky's reviewer approved PR #42"

### Backlog
- `Claimed by [matts-orbital]` chip per locked task
- Filter: "Mine" / "All" / "Specific operator"

### Channels (revised from local-only)
- Same UI; the data now syncs across operators in real time
- Member presence per channel

### Inspection (Round 6 #10 extension)
- Worker grid shows BOTH installs' workers with operator badges
- Filter: "All" / "Mine" / "Ricky's"
- Cost gauge per worker shows the OWNING operator's burn (not hub aggregate)

### Cost (Round 6 #5 extension)
- Default view: your own spend only
- "Team aggregate" view if the hub has shared-cost-visibility enabled

## Acceptance criteria (high-level for the round; each sub-task has its own)

1. Two laptops paired with one hub via invite-token flow.
2. Both UIs show the same backlog board, real-time sync.
3. Matt's UI files a defect on a task; Ricky's UI shows the defect within 1 second.
4. Matt's worker spawns locally; Ricky's UI's Inspection page shows the worker live with operator badge.
5. Each laptop's cost dashboard shows only its own LLM spend.
6. Hub down → both UIs show "disconnected" banner, local agents continue, mutations queue.
7. Hub back → outboxed events sync to hub in order, no duplicates (event_id idempotent).
8. Audit event stream on hub includes `actor.install_id` for every event from both operators.
9. Anthropic key NEVER appears in any request to the hub (CI check).
10. Self-host: `docker compose up -d` brings the hub up; both laptops can connect.

## Out of scope (Round 8+)
- Multi-tenant hub serving multiple TEAMS (not just multiple operators in one team) — that's a SaaS-product question
- Permissions matrix beyond owner/member
- Voice/video collaboration in shared channels
- Synchronous pair-programming (operator + agent in same worktree)
- Cross-team / inter-org collaboration with strict data isolation

## Dependencies
- All of Round 6 should be complete (#1 PR loop, #3 defect, #4 memory, #5 cost, #7 replay, #9 channels, #10 inspection are all touched by the local-vs-hub split)
- Cloud-port story (the "Tier 1" single-VM cloud setup discussed elsewhere) maps directly onto hub deployment

## Total estimate
~6–8 weeks of senior-engineer time at this complexity. With a properly parallelized agent fleet (after Round 6's coordination machinery), realistically 4–6 days of agent-time if dependency batching is done well.

## What this enables next (Round 8 candidates)
- **Self-serve SaaS hub** — Orbital-the-product where teams sign up, get a hub URL, billing
- **Multi-org collaboration** — different companies' Orbital hubs federating with strict isolation
- **Cloud-only operator** — light operator UI in the browser pointing at the hub, no local install (for stakeholders/PMs who don't spawn agents themselves)

## Persona evidence prefix
Each sub-task: `[Engineer-{tier} · {model} · run-round7-NN-{name}]`
