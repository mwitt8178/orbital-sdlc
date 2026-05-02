# Round 7-08 — Operator-Attributed UI

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Low · Estimate: M

## Depends on
7-02 (local-hub split), 7-03 (federation auth — gives us install_id on every event), 7-04 (real-time push — for live presence)

## Why
After 7-01–7-07, the data is shared and synced. But the UI must MAKE the collaboration visible: who claimed what, who reviewed what, who's online, whose agents are running. Without this surface, the team experience is invisible — operators won't know they're collaborating.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `events/types.ts` | existing | Verify every event has `actor.install_id` (it should after 7-03 — sanity-check) |
| `personas/anthropic-driver.ts` (the wrapper) | existing | Persona evidence prefix in agent output now includes install display name: `[matt-laptop · Engineer-Sr · Sonnet · run-X]` |
| `github/pr-body-builder.ts` (Round 6 #1) | existing | PR body footer includes `Built by [matt-laptop] · sr-dev · Sonnet` |
| `github/pr-orchestrator.ts` | existing | PR review comments authored by an agent include the operator badge in the body |
| NEW `ui/src/components/identity/OperatorBadge.tsx` | New | Reusable badge: avatar, display name, role, online indicator |
| NEW `ui/src/components/identity/OperatorFilter.tsx` | New | Filter chip: "All / Mine / Specific operator" |
| NEW `ui/src/components/identity/PresenceIndicator.tsx` | New | Online/offline dot with tooltip "last seen Xm ago" |
| `ui/src/pages/Dashboard.tsx` | existing | New "Team" panel: member presence, recent activity stream |
| `ui/src/pages/Backlog.tsx` | existing | OperatorBadge per task (claimed_by); OperatorFilter |
| `ui/src/pages/AgentInspector.tsx` (Round 6 #10) | existing | OperatorBadge per worker; OperatorFilter; "All / Mine / Ricky's" toggle |
| `ui/src/pages/Channels.tsx` | existing | Each message shows OperatorBadge of author; presence list per channel |
| `ui/src/pages/Audit.tsx` | existing | OperatorBadge column |
| `ui/src/components/features/pr/PRDetailPanel.tsx` (Round 6 #1) | existing | "Reviewed by [ricky-laptop · reviewer · Sonnet]" instead of generic agent name |
| `ui/src/components/features/uat/DefectTimeline.tsx` (Round 6 #3) | existing | OperatorBadge per iteration |

## Identity primitive (`OperatorBadge`)
```tsx
<OperatorBadge
  installId="..."
  size="sm" | "md" | "lg"
  showRole?: boolean
  showPresence?: boolean
/>
```
Lookups go through a cached query `team.members` → returns `{ install_id, display_name, role, last_seen_at, color }`. Each operator gets a stable color (hashed from install_id) for visual scanning across the UI.

## Presence
A WS heartbeat from each connected client to hub every 30s updates `known_installs.last_seen_at`. Hub broadcasts presence changes (online/offline transitions) to subscribers of `team:presence`.

UI considers an install "online" if `last_seen_at < now() - 90s`.

## Frontend UX details

### Dashboard "Team" panel
- Avatar grid of all known_installs in tenant
- Per avatar: display name, role, online/offline dot, agents-running count, last-active
- Click → filters all views to that operator

### Backlog
- Each task row: `OperatorBadge size="sm"` next to claim status
- Filter chip: All / Mine / Other operators
- Quick action: "Hand off to [operator]" — releases claim with optional note

### Agent Inspector (Round 6 #10 extension)
- WorkerCard gains operator badge in header
- Grid filter: All / Mine / Specific operator
- Sort: by operator, by activity, by cost-burn

### Channels
- Each message: `OperatorBadge size="sm"` + name
- Sidebar lists channel members with presence dots
- @mentions trigger notifications to mentioned install (UI bell + optional Slack-bridge later)

### Defect timeline (Round 6 #3 extension)
- Per iteration: `Built by [matt-laptop]` or `Iteration triggered by defect from [ricky-laptop]`
- Operator-attributed handoff visible

### PR detail panel (Round 6 #1 extension)
- "Reviews" tab: each review row gets reviewer's OperatorBadge
- Activity timeline: events show operator avatars

## Color assignment
Hash install_id → HSL hue (deterministic). Saturation/lightness fixed for accessibility (WCAG AA contrast against both light + dark themes). Test: any two installs in the same tenant have visually distinguishable colors (delta-E > 20 in CIELAB).

## Acceptance criteria
1. `OperatorBadge` renders correctly for all sizes; presence dot updates within 5s of online/offline transition.
2. Backlog rows show claimed_by as a badge; filter chip narrows view to specific operator.
3. Agent Inspector shows BOTH operators' workers when "All" filter; only one's when "Mine" or specific.
4. Channels: each message attributes correctly; presence list updates live.
5. PR review comment posted by ricky's reviewer-agent shows ricky's badge in the UI; the GitHub PR review body footer includes the same attribution.
6. Audit page: every event row has `actor.install_id` rendered as a badge.
7. Color stability: same install_id → same color across all UIs and sessions.
8. Dashboard "Team" panel: avatar grid renders all members; presence transitions are live.

## Hard-stop grep checks
```
grep -rE "OperatorBadge" packages/ui/src/ | wc -l    # should be ≥ 8 (used across many pages)
grep -E "team\\.members|team:presence" packages/orchestrator/src/trpc/ -r
grep -E "actor.install_id" packages/orchestrator/src/events/ -r | head
```

## Out of scope
- Custom avatars (default = initials in the operator's color); upload feature is Round 8 polish
- Operator profiles / bios — overkill for v1
- Following / unfollowing operators — overkill

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round7-08-operator-attribution]`
