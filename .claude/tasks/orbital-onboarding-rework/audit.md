# Orbital Onboarding + Project-Setup UX Audit

[Engineer-Principal · Opus · run-orbital-onboarding-rework]
Date: 2026-05-03
Scope: `/welcome`, all 3 onboarding flows, `/settings/*`, project-setup edges.
Live target: `https://d2mtgpa71y9c8t.cloudfront.net`.

---

## Executive summary

Today's onboarding "works" in a happy-path/test-spec sense (the e2e passes) but
is shaped like a developer's todo-list, not a product. The Welcome page is a
stack of three near-identical cards; the wizard pages are full-width plain-form
boxes; the Settings page is fourteen tabs in alphabetical order; and the actual
edges (refresh, network drop, back-button, skipping) are inconsistently handled
across the three flows.

This rework upgrades each surface from "wireframe in production" to a designed,
defensible product onboarding — with intentional information hierarchy, real
microinteractions, mobile-floor behavior, and a Settings IA that isn't just a
tab strip.

---

## 1. Welcome page (`/welcome`) — what's broken

### Visual
- **Three identical generic cards.** No hero, no single visual focal point, no
  hierarchy between primary path ("new project") and secondary paths
  ("connect existing", "join team"). The cards are visually weighted equally
  even though they map to dramatically different user intents.
- **Emoji as iconography** (🚀, 🔍, 👥). Reads as placeholder. Inconsistent with
  the rest of the brand, which uses stroke icons.
- **No personality.** No tagline, no product positioning, no preview of what
  Orbital actually *is*. A user who lands here cold has zero context.
- **Cost/time badges in card corners** — useful info, but their placement
  (top-right of every card) makes them visually heavy and noisy.
- **Single CTA per card is hidden** behind making the whole card a button —
  no explicit "Start" or affordance signaling "this is the primary action".
- Header `OnboardingShell` shows a single dot labelled "Pick a path" — a
  one-step progress bar is meaningless visual chrome.

### IA / state
- Resume logic dumps the user back into the active flow's current step, but
  shows only a single-step progress bar (`steps={[{ id: currentStep, ...}]}`)
  — they lose the sense of "I'm 4 of 8 done".
- No way to abandon an in-flight session. If you start `new_project`, change
  your mind, refresh — you're locked back into `new_project` until you complete
  or hit some untested back-channel.
- "You can always switch later" copy promises what isn't actually wired.

### Mobile
- Grid drops to single column under `md:`, but card heights are unequal because
  description text varies → ragged.
- Cost/time badges wrap awkwardly on 375px because they're a flex column inside
  the card header.

---

## 2. Onboarding wizard shell

### Visual
- Plain `bg-slate-50` page, plain white card, plain header. Looks like a basic
  Tailwind starter.
- Header logo is tiny (28×28) and Orbital wordmark is light. No real brand
  presence; no sense of "you're inside a product" vs "you're filling a form".
- Progress bar is centered with no left-anchor, so labels visually float.
  On md+ it's labelled, on smaller it's just dots — labels disappear entirely
  below `md:`.
- Continue/Back footer is generic Buttons with no animation, no transition,
  no microcopy ("Saving…" disappears the moment the mutation resolves).

### State machine gaps
- **Auto-advance side effects in `useEffect` keyed only on `step`.** The
  NewProjectFlow effect for `monday_provision`, `github_provision`, `system_teach`
  triggers actions when step changes, but the deps are eslint-disabled. If a
  user back-navigates and re-enters a provisioning step, the existing logic
  guards on local state (`mondayBoardId`, `github`, `memoryEntryIds.length`)
  but those local guards are wiped on a hard reload. Resume loads
  `initialState`, but the local `useState` defaults read from `initialState`
  only on first mount — refresh in the middle of provisioning re-runs.
- **No in-progress provisioning lock.** Two concurrent calls to
  `createMondayBoard` will both fire if React re-renders. The mutation isn't
  idempotent server-side (we don't dedupe on `sessionId`).
- **Skip path for Monday provisioning is silent.** If `tools.mondayConnected`
  is false, the effect calls `advance('github_provision')` with no UI state
  — user sees the provisioning panel briefly flash before jumping.
- **`startSession` is fire-and-forget.** No optimistic UI — user clicks card,
  page sits doing nothing for ~300ms while the mutation round-trips, then the
  flow snaps in.
- **Back button is `disabled={!canGoBack}` defaulted to true everywhere** but
  the actual flow components don't pass an `onBack`, so clicking it does
  nothing. Dead button.

### Edges not actually handled
- **Network failure mid-wizard:** `update.mutateAsync` errors are swallowed
  into a red box at the bottom — no retry, no "your last change wasn't saved",
  no offline indicator. User just sees an error and a Continue that still works.
- **Reload during provisioning:** `runMondayProvision` writes `monday_board_id`
  to server state only after success. If the call is in flight when the user
  refreshes, the client comes back to `step='monday_provision'` with no board
  id and re-fires. Server has no idempotency key.
- **Skip-for-now copy is a one-liner under the field** — no sense that
  "skipped" tools are recoverable in Settings (recovery hint exists but its
  styling is muted to invisible).
- **Inline validation only fires after first blur** (good) but the "saved"
  state for Anthropic/Monday/GitHub tokens has no visual save-in-progress dot
  — it just flips from button to "✓ connected". Feels broken on slow networks.
- **No "test connection" on tokens.** The mutation does validate, but the user
  has no separate "test" affordance — save-and-validate are conflated.

### Mobile (375px)
- Card padding is `p-8` everywhere → on 375px the inner content gets squashed
  edge-to-edge with very little breathing room.
- Continue/Back footer is `flex justify-between` → on a narrow viewport with
  long button labels ("Save & validate" / "Continue") they collide.
- Stack-pill toggle group on `VisionIntakeStep` wraps but rows of pills end up
  uneven because each pill is content-width.

---

## 3. New-project flow specifics

- **Project basics**: 3 fields, no preview of what the slug actually becomes.
  No "reserved slug" check — user can type "admin" or "settings" and break
  routing later.
- **Connect tools step**: 3 stacked cards but the Anthropic card has no API
  key visibility toggle (it's `type="password"` always). On mobile, the
  password field is ~30 chars wide → user can't see what they pasted.
- **Vision intake**: 20-char minimum is arbitrary and unexplained. The user
  doesn't know what the agents will *do* with this text. The "Locked" copy
  reads as a system message, not a UX state.
- **Provisioning panels** show a list of fake-progress checkmarks that all
  flip from `·` to `✓` together when the call resolves. It's fake-real — the
  copy says "Real progress, not animation" but visually it IS one big animation.
- **System-teach panel**: same shape as the provisioning panels, but the
  user has no way to inspect *what was learned*. They just see "Seeded N
  memory entries" — no link to /memory yet.
- **Mode + budget** step is labelled "Mode + budget" but exposes only mode
  selection — budget is mentioned in body copy as immutable defaults
  ($20/sprint, $100/week). Misleading title.
- **First sprint**: launch / edit / skip — no explanation of what each path
  means until you click. Should preview "Launch creates a sprint with 3
  inferred tickets" inline.
- **Done step**: text dump of summary sections, then 3 buttons (Launch / Tour
  / Watch Inspector). All three buttons just call `onComplete()` — they don't
  actually do different things. Dead choice.

---

## 4. Existing-repo flow specifics

- **Connect repo**: 3 fields (owner / repo / monday-board-id) with no hint that
  the user needs to authorize Orbital on GitHub *first*. If GitHub isn't
  connected yet, this step silently creates a session that will fail later.
- **CodebaseAnalysisStep** runs a tRPC mutation (`analyzeCodebase`?) but the
  user sees a spinning panel with no "what we're looking at" detail — no
  file count, no language histogram, nothing to suggest "we're looking at YOUR
  code right now".
- **Board mapping step** is "Confirm or Skip" with no preview of mapped
  columns. User has no idea what the mapping is.
- **Memory seed step** is "Confirm or Skip" with a count — but no preview
  of any of the inferred entries. User can't sanity-check what's about to
  be written into their memory store.
- **No mode/budget defaults differ from new-project flow** — the existing-repo
  user is signaled they're more advanced but gets the same canned defaults.

---

## 5. Join-hub flow specifics

- Lives entirely in `JoinHubFlow.tsx`, not wrapped in the same shell. Visual
  inconsistency: no progress bar, no logo, no "you're in onboarding" framing.
- Asks for invite URL + display name in plain inputs, no example state.
- Error path mentions a CLI fallback (`npm run hub:join`) — exposing terminal
  commands in a product UI is a code smell. Power-user fallback is fine, but
  it should be tucked behind an "advanced" disclosure, not the primary error
  UI.
- Success state shows raw `tenant_id`, `role`, `hub_pubkey` like a debug panel.
  No human framing ("You're in. Welcome to Acme Co.").
- Asks user to "reload the page to see hub-mode UI" — should reload itself
  and route to the dashboard.

---

## 6. Settings IA — what's broken

- **14 tabs in a horizontal strip** with `overflow-x-auto`. On 375px, only
  ~3 tabs fit on screen. No grouping, no hierarchy.
- **Alphabetical-ish order** mixes user-facing settings (personas, ceremonies)
  with infrastructure (hooks, identity, hub) with policy (routing, models,
  budget). Unscannable.
- **Read-only v1** — but no explicit signal in the UI that values can't be
  changed. Users will try to click and get nothing.
- **GitHub tab is separate from Identity/Hub/Anthropic** — the integrations
  story is fragmented across `github`, `monday-from-identity`, `hub`.
- **No sub-routes**: everything lives at `/settings#tab-id`. Deep linking works
  via hash but breaks browser back-navigation between sub-views.
- **Header breadcrumb says "Acme Product" hardcoded** — leftover from the mock.

---

## 7. Cross-cutting

- **No design tokens for spacing scale, type scale, or shadows beyond a single
  `--shadow-card`.** Tailwind v4 default scale is being used everywhere; we
  have no project-specific 4-step shadow scale, no display vs body type
  distinction, no spacing rhythm enforced.
- **No microinteractions.** Clicks are snap-cut. Card hovers raise from
  `border-slate-200` to `border-brand-400` instantly. No motion.
- **No empty/loading/error standardization.** Every page rolls its own.
- **Mobile floor is undefined.** Some pages are usable at 375px; others have
  fixed-width tables that overflow.
- **Auth pages (Login/Signup/Verify) were built separately** and don't share
  the OnboardingShell visual language. New users see Login → Verify → Welcome
  → Wizard → Dashboard, and each transition resets the visual theme.

---

## 8. Rework plan (high-level)

| Surface | Action |
|---|---|
| `index.css` `@theme` block | Add type scale, spacing rhythm, shadow scale, motion tokens |
| `Welcome.tsx` | Rebuild: hero + asymmetric layout, primary "Start a project" CTA + secondary paths in a different visual register |
| `OnboardingShell.tsx` | Larger logo, sticky footer, save indicator slot, mobile-first padding scale, motion |
| `OnboardingProgressBar.tsx` | Multi-step bar visible at all viewport widths; current-step label always visible |
| `NewProjectFlow.tsx` | Idempotency on provisioning; explicit save indicator; preview of slug → URL; reserved-slug check; show inferred ticket preview before "Launch" |
| `ExistingRepoFlow.tsx` | Show what's being analyzed (file counts, language); preview board mapping; preview memory entries before seed |
| `JoinHubFlow.tsx` | Wrap in OnboardingShell; humanize success/error; auto-reload to dashboard |
| `Settings.tsx` | Sub-route IA: `/settings/{general,integrations,agents,sprints,team,billing}`; sidebar nav |
| `IntegrationsSubpage` | Rebuilt — one card per provider with status pill, last-sync, test-connection button |
| Placeholder sub-pages | Designed coming-soon state, not stubs |
| New `framer-motion` usage | Card hover-raise, page transitions, save indicator pulse |
| Playwright screenshot harness | All screens at 375px + 1280px to `/tmp/orbital-onboarding-screenshots/` |

---

## 9. Risk + rollback

- All changes are UI-only (no DB schema, no IAM, no Lambda). Deploy is S3
  sync + CloudFront invalidate.
- Rollback: redeploy previous bundle from git tag (`git checkout 6c9f5c0 --
  packages/ui && cd packages/ui && npm run build && aws s3 sync dist/ ...`).
- Blast radius: `/welcome`, `/settings/*`, onboarding flow only. Dashboard,
  Vision, Channels, etc. untouched.

---

## 10. Out of scope (deliberately)

- Backend tRPC procedures — no API changes.
- Auth pages (Login/Signup/Verify) — separate workstream.
- Dashboard, Vision, Channels, Cost — untouched.
- Schema changes to `onboarding_sessions` — no.

