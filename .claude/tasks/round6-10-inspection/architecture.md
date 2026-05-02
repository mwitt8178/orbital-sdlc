# Round 6 — #10 Live Operator Inspection Layer

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: M

## Why
`orchestration.workers.list` and `getRecentOutput` give a basic worker list and a stdout tail. The next level — and what builds operator trust in an unattended system — is the factory-floor view: per-agent tool call timeline, which skill loaded when, why a routing decision was made, current capability scopes, current cost burn against budget. "Can I see what every agent is thinking right now?" — answered today only by stdout.

## Independent of #1
Mostly UI work + read-side tRPC. No file overlap with #1's spawn/post-task. Can run in Wave 3.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `mcp/gateway.ts` | existing | Emit `ToolCallStarted` and `ToolCallCompleted` events on every tool call (with tool_name, args summary, duration, ok/err) |
| `personas/anthropic-driver.ts` | existing | Emit `LLMRequestStarted` and `LLMRequestCompleted` events |
| `events` | new types as above + `SkillLoaded` on persona briefing | `SkillLoaded` fires once-per-worker when `personas/skill-loader.ts` wraps the worker brief |
| `orchestration/spawn.ts` | existing | After spawn, emit `WorkerStarted` (already exists?) + emit `WorkerLifecyclePhase` for major transitions (briefing, running, idle, terminating) |
| `inspection` (NEW) | `packages/orchestrator/src/inspection/{service.ts,types.ts}` | Aggregator: given worker_id, returns combined live state from events + ephemeral worker_id-keyed in-memory cache |
| `trpc` | existing `orchestration` router | New: `orchestration.workers.inspect({worker_id})` returning rich live state; `orchestration.workers.timeline({worker_id, since})` |
| `ws/hub.ts` | existing | Propagate ToolCallStarted/Completed, LLMRequestStarted/Completed, SkillLoaded events to subscribed UI clients |
| `ui` | NEW `pages/AgentInspector.tsx`, NEW `components/features/inspection/{WorkerCard.tsx,ToolCallTimeline.tsx,SkillStack.tsx,CapabilityScope.tsx,LiveCostMeter.tsx,KillButton.tsx}` | Factory floor view |

## Data shape: `WorkerInspection`
```ts
export interface WorkerInspection {
  workerId: string
  taskId: string
  ticketId?: string
  persona: { id: string; name: string; tier: string }
  model: { provider: string; model: string }                 // from #8
  state: 'starting' | 'briefing' | 'running' | 'awaiting' | 'idle' | 'terminating' | 'terminated'
  startedAt: string
  lastActivityAt: string

  capability: {
    scopes: { filesRead: string[]; filesWrite: string[]; channelPost: string[]; /* etc */ }
    expiresAt: string
  }

  skillsLoaded: { id: string; loadedAt: string; sourceSha256: string }[]

  recentLLMCalls: { startedAt: string; durationMs?: number; status: 'pending'|'ok'|'err';
                    inputTokens?: number; outputTokens?: number; costUSD?: number }[]
  recentToolCalls: { name: string; startedAt: string; durationMs?: number; status: 'pending'|'ok'|'err' }[]

  costToDate: { tokens: number; usd: number }                // from #5 cost ledger
  costBudgetForScope?: { hardCap: number; softThreshold: number; pctUsed: number }

  recentChannelPosts: { channel: string; bodyExcerpt: string; postedAt: string }[]   // from #9

  outputTail: string[]                                        // last N stdout/stderr lines
}
```

## Frontend UX

### `pages/AgentInspector.tsx` (new) — primary entry point
- Top filter: sprint / persona / state / model
- Grid of `<WorkerCard>` (one per active worker)
- Click a card → opens detail drawer (full WorkerInspection)
- Live updates via WS — dot pulses when worker emits a new event in the last 2s

### `WorkerCard.tsx` (new)
- Header: persona avatar, model badge, state badge (color-coded), worker_id (short)
- Body:
  - Current task title + ticket id
  - "Doing now" — most recent operation (e.g., "Calling claude-sonnet-4-6", "Running tool: Edit", "Awaiting verifier")
  - LiveCostMeter — gauge showing % of budget burned
  - Skills loaded (icons row)
- Footer: started X ago · last activity Y ago · KillButton (capability-gated)

### `ToolCallTimeline.tsx` (new) — drawer content
- Vertical timeline of tool + LLM calls in chronological order
- Each entry: icon (tool kind / LLM), name, args summary (truncated), result status, duration
- LLM calls show in/out token counts and cost
- Tool calls show outcome (ok/err) and 1-line excerpt
- Click any entry → expands to full args/result (linked to Replay #7 if available)

### `SkillStack.tsx` (new)
- Visual stack of loaded skills
- Per skill: name, source_sha256 (verifies hook integrity), trigger reason ("loaded because: persona=sr-dev")
- Click → opens skill markdown content

### `CapabilityScope.tsx` (new)
- Visual rep of: filesRead, filesWrite, channelPost, boardMutate, etc.
- Highlights any scope that was DENIED at the gateway in the last 5 min (red badge "1 denial")
- Capability TTL countdown (issued: X min ago, expires: Y min)

### `LiveCostMeter.tsx` (new) — gauge component used in card + drawer
- Dial showing 0-100% of budget for the worker's scope (from #5 cost data)
- Updates on CostLedgerAppended events
- Hover → tooltip with breakdown (input + output + cache tokens)

### `KillButton.tsx` (new)
- Red button "Terminate worker"
- Confirmation: "Are you sure? This will SIGTERM the worker; the task will be marked aborted."
- Capability-gated; logs WorkerKilledByOperator event with operator identity + reason

### Sidebar nav
- New entry "Agents" between "Dashboard" and "Backlog" (or wherever fits)

## WS subscription model
- Client subscribes to `inspection:worker:<worker_id>` for the open drawer.
- Client subscribes to `inspection:active` for the grid refresh.
- Server filters event stream by aggregate_type=worker (or aggregate_id=workerId) and pushes to matching subscriptions.

## Acceptance criteria
1. `grep -rE "ToolCallStarted|ToolCallCompleted" packages/orchestrator/src/mcp/gateway.ts` ≥2.
2. `grep -rE "LLMRequestStarted|LLMRequestCompleted" packages/orchestrator/src/personas/anthropic-driver.ts` (or drivers/anthropic.ts after #8) ≥2.
3. Integration test: spawn fake-worker → exercise 3 tool calls + 2 LLM calls → assert `inspect({worker_id})` returns 3 toolCalls + 2 llmCalls + skillsLoaded list + capability.scopes.
4. Live update: WS subscription emits ≥1 event when worker performs new tool call.
5. UI: AgentInspector page lists active workers, opens drawer with full detail; LiveCostMeter visibly fills as a worker burns budget (verified via Playwright or React Testing Library + RxJS-style fake clock).
6. Kill button: clicking with confirmation calls `admin.workers.kill` mutation; emits WorkerKilledByOperator event.

## What "wired up" means
- Every tool call in MCP gateway emits the events. Not just "in the happy path"; the catch path emits ToolCallCompleted with status=err too.
- WS hub propagates the new events. Subscribed UI clients receive them.
- AgentInspector page is route-registered AND linked from sidebar.

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round6-10-inspection]`
