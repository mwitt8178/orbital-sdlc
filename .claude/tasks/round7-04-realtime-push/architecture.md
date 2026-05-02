# Round 7-04 — Real-Time Push From Hub To Clients

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: M

## Depends on
7-01 (hub), 7-02 (split), 7-03 (auth)

## Why
The local UI today subscribes to a local WS hub for live updates. After 7-02 the data lives on the hub — so the WS subscription must follow. Without real-time push, both operators' UIs would only see each other's changes after a manual refresh.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `ws/hub.ts` | existing | Becomes the hub-mode WS server. Authenticates on connect via signed envelope (same as HTTP). Tenant-scopes all subscriptions. |
| NEW `ws/subscriptions.ts` | New | Per-connection subscription registry: `subscribe:task:<id>`, `subscribe:channel:<name>`, `subscribe:project:<id>:events`, `subscribe:worker:<install_id>:*` |
| `events/store.ts` | existing | After `append`, fan out the new event to every connected WS subscriber whose subscription matches. |
| NEW `hub-client/ws-client.ts` (paired with 7-02's hub-client) | New | Local-side WS client. Reconnects with backoff on drop. Emits to local React Query cache for instant UI invalidation. |
| `ui/src/hooks/useHubSubscription.ts` | NEW | React hook: `useHubSubscription('task:123', onEvent)` — subscribes on mount, unsubscribes on unmount, re-subscribes after reconnect |

## Subscription patterns
| Pattern | Who subscribes | Triggers |
|--|--|--|
| `task:<id>` | Task detail drawer, Backlog row | tasks.* events for that id |
| `channel:<name>` | Channels page, EscalationBanner | comms.* events for that channel |
| `project:<id>:events` | Audit page, Dashboard activity feed | every event aggregate-typed to that project |
| `worker:<install_id>:*` | Inspection page (Round 6 #10) | WorkerLifecycle, ToolCall*, LLMRequest* events from that install |
| `worker:*` | Inspection (admin filter "all operators") | same as above, all installs |

Subscriptions are tenant-scoped at the server: a subscriber's `ctx.tenantId` must match the event's tenant. Cross-tenant leakage = critical bug.

## Reconnect & backoff
Exponential backoff: 1s → 2s → 4s → max 30s. On reconnect:
1. Re-authenticate (signed envelope on initial WS handshake).
2. Re-subscribe to all previous subscriptions.
3. Request "events since `last_seen_event_id`" via a one-shot HTTP call to backfill missed events.
4. Resume push.

## Frontend UX
- Topbar dot: green = connected, yellow = reconnecting, red = down for >60s
- Each subscription shows live update animation (e.g., new comment slides in)
- "Disconnected" banner when red — local-only data still browseable

## Acceptance criteria
1. Local UI subscribes to `task:<id>` on detail-drawer open. Another operator mutates the task via hub. Local UI receives event within 500ms.
2. Reconnect: kill the WS, observe yellow dot. Restart hub. Within 5s the dot is green and previous subscriptions are restored.
3. Backfill: WS down for 30s during which 5 events occurred. On reconnect, all 5 events are delivered (verify by event_id sequence).
4. Tenant isolation: a subscriber on tenant A does NOT receive events from tenant B (paramaterized test).
5. Authentication: WS handshake without valid envelope → 4001 close code AUTH_REQUIRED.
6. Memory pressure: 1000 concurrent subscriptions per hub server stay under 500MB heap (load test).

## Hard-stop grep checks
```
grep -E "useHubSubscription" packages/ui/src/ -r | head
grep -E "subscribe:task|subscribe:channel|subscribe:worker" packages/orchestrator/src/ws/ -r
grep -E "tenant" packages/orchestrator/src/ws/subscriptions.ts
```

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round7-04-realtime-push]`
