# Round 6 — #9 Inter-Agent Channel Collaboration

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: M

## Why
Capability scopes for `channel_post` exist in scheduler/pause/brief — the *plumbing* exists — but `grep` shows agents do NOT post during work. So today the comms substrate is for human↔agent only, not agent↔agent. Turning that on (agents asking for help in `#sprint-X`, escalating to senior personas, handing off subtasks) is what turns parallel workers into an actual team.

## Depends on
Wave 5 (#2 reviewer + #3 defect-iter) — they introduce the natural use cases for channel posts (escalation, hand-off).

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `comms/` | existing | Verify channel APIs work; add `channel.subscribe(workerId, channelGlob)` capability gate |
| `mcp` | existing gateway | Surface tools `comms.post`, `comms.read`, `comms.subscribe` to agents — these exist? Check; add if missing |
| `personas/skills/` | NEW `escalation-protocol.md`, `hand-off-protocol.md`, `peer-help-protocol.md` | When/how to use channels |
| `personas/library/*` | existing 11 + reviewer (#2) | Update each persona's capability profile to include sensible `channelRead`/`channelPost` defaults |
| `orchestration/scheduler.ts` | existing | New: subscribe to `EscalationRaised` events; create child task for the escalation target persona |
| `events` | new types: `AgentChannelPosted`, `EscalationRaised`, `HandOffRequested`, `PeerHelpRequested` | aggregate=channel + cross-link to source task |
| `trpc` | existing `channels` router | Extend with: `channels.byWorker({worker_id})`, `channels.escalations({sprint_id})` |
| `ui` | `pages/Channels.tsx` (existing), NEW `components/features/channels/AgentTalkView.tsx`, NEW `components/features/channels/EscalationBanner.tsx` | Agent-to-agent thread view |

## Channel protocols (skill: `escalation-protocol.md`)
- **Escalation triggers**:
  - confidence < threshold (per Risk Tier; from `confidence-escalation` skill)
  - 3 retries with same blocker
  - capability denied at gateway and no workaround
  - reviewer requests changes the author cannot resolve in N iterations
- **Action**: `comms.post('#escalation-' + sprint_id, body, mentions=['@em','@principal-dev'])`
- **Side effect**: emit `EscalationRaised` event with source task_id + target_persona_hint
- **Scheduler**: subscribes to `EscalationRaised` → creates child task with persona=target (from hint) and parent_task_id=source

## Hand-off protocol
- An author task discovering it needs work on a different bounded context (e.g., a UI task realizing it needs schema changes) posts to `#sprint-{id}` with a hand-off note + emits `HandOffRequested`.
- A new task is created by the scheduler with the appropriate persona (matched on the post's mention).

## Peer help protocol
- Author stuck on a stylistic/architectural choice posts to `#orb-engineering` asking for help; senior personas (em, architect) subscribe and may post back without spawning a full task.
- Capability: jr-dev/sr-dev have `channelPost: ['#orb-*']` already; verify reviewer + verifier do too.

## Frontend UX

### `pages/Channels.tsx` (extend)
- Existing channel list left, message stream right.
- New tab on each channel row: "Agent activity" — filter to AgentChannelPosted events
- Per message: persona icon + name + model + cost-of-this-message (small badge)
- Threading: replies form a tree; clicking a message opens a thread side-panel

### `AgentTalkView.tsx` (new — embedded in Sprint board / Backlog drill-down)
- Shows agent-to-agent conversation per task or per sprint
- Visualizes: sender → receiver edges, time, channel, message excerpt
- Helps operator see "the team is collaborating" at a glance

### `EscalationBanner.tsx` (new — top of Backlog/UAT/Channels)
- Prominent banner when there's an unresolved escalation
- "3 active escalations · 1 awaiting human review · view all"
- Click → filter Channels to escalations only

### Worker drawer (extend Wave 3 #10)
- Show recent channel posts by this worker
- "Post to #X" affordance if operator wants to nudge the agent (capability-gated; logged)

## Capability profile defaults (update `personas/library/*.ts`)
```ts
// jr-dev: peer-help only
channelRead: ['#orb-engineering','#sprint-*']
channelPost: ['#orb-engineering']

// sr-dev / principal-dev / architect / em: full
channelRead: ['#orb-*','#sprint-*','#escalation-*','#review-*']
channelPost: ['#orb-*','#sprint-*','#escalation-*','#review-*']

// reviewer (#2): review channels only
channelRead: ['#review-*','#orb-engineering']
channelPost: ['#review-*']

// verifier (Round 5C): verification only
channelRead: ['#verification-*','#orb-*']
channelPost: ['#verification-*']
```

## Acceptance criteria
1. `grep -E "comms.post|channel.post" packages/orchestrator/src/personas/skills/escalation-protocol.md` returns ≥1 reference.
2. `grep -rE "EscalationRaised|HandOffRequested|PeerHelpRequested" packages/orchestrator/src/events/types.ts` returns 3 hits.
3. Integration test: spawn fake-worker with low confidence → posts to escalation channel via gateway → EscalationRaised event written → scheduler creates child task with target persona.
4. Capability gate: jr-dev attempting to post to `#sprint-X` (which is not in its allowlist) is rejected by gateway with AUTH_SCOPE_DENIED.
5. UI: Channels page shows agent activity; EscalationBanner appears when escalation is unresolved.
6. End-to-end: a confidence-failure escalation completes the round-trip — post → event → child task → spawn → resolution comment back in channel.

## What "wired up" means
- The fake-worker harness used by tests actually exercises `comms.post` via the gateway — not bypassing it.
- Scheduler subscribes to EscalationRaised events — `grep "EscalationRaised" packages/orchestrator/src/orchestration/scheduler.ts` ≥1.
- Channels page renders agent-authored messages distinguishably from human messages.

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round6-09-channel-collab]`
