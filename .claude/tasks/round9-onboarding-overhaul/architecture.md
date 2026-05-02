# Round 9 — Onboarding UX Overhaul

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: XL (largest in Round 6 — full UX surface + active SDLC bootstrap)

## Why
Today's `/welcome` is a stub. "Leave nothing to the imagination" is the right standard. Beyond UX, Orbital must ACTIVELY set up the team's SDLC infrastructure for new projects (creating the Monday board with proper columns/statuses + creating the git repo + wiring CI), and ANALYZE existing projects to teach itself how to use that team's already-running SDLC.

## Three personas, three flows

| Persona | First-touch | Path |
|---|---|---|
| Never-tried explorer | Sample data, no creds | Flow D — sandbox |
| Solo operator (you) building from scratch | Vision intake → Monday board + git repo CREATED by Orbital → first sprint | Flow A — new project |
| Solo or team operator with existing project | Existing GitHub repo + existing Monday board → Orbital learns | Flow B — existing import |
| Team member joining | Paste invite URL | Flow C — join hub (Round 7 capability) |

## Flow A — New project (Orbital BUILDS the SDLC)

After vision intake locks, Orbital actively creates the team's SDLC infrastructure. This is the differentiator: not just "type your tokens," but "we set up your board, your repo, your pipeline, then teach the agents to use it."

### A-step: Monday board creation
Inputs: Anthropic-OK vision is locked.

Orbital calls Monday API to:
1. Create a board named `<project-name> — SDLC` in the user's chosen workspace
2. Add the canonical column set per the existing `sdlc-monday-board` skill:
   - **Workflow Status** (Status column): values M0 Backlog → M1 Specced → M2 Ready → M3 In Progress → M4 In Review → M5 QA → M6 Approved → M7 Deployed → M8 Closed
   - **Risk Tier** (Status): Low / Medium / High / Critical
   - **Estimate** (Status): XS / S / M / L / XL
   - **Author** (People): set automatically when claimed
   - **Reviewer** (People): assigned at M3
   - **QA Tester** (People): assigned at M5
   - **Acceptance Criteria** (Long Text)
   - **Confidence** (Numbers): 0-100
   - **Token Cost** (Numbers): rolled up from cost ledger
   - **PR Link** (Link): populated by Round 6 #1
   - **Rollback Plan** (Long Text): SOC 2 evidence
   - **SOC 2 Controls** (Status): mapped per skill rules
3. Persist the resulting board_id + column ids into `board_mappings` (Round 5 work) so the system uses them automatically
4. Emit `MondayBoardProvisioned` event

UI shows live progress:
```
Setting up your Monday board...
  ✓ Created board "Apprentice — SDLC" (id: 1234567)
  ✓ Added 12 columns
  ✓ Configured 9 workflow statuses
  ✓ Mapped to Orbital's SDLC schema
```

If user opted out of Monday during creds: skip this entirely. Backlog = Orbital-internal.

### A-step: Git repo creation
Inputs: GitHub OAuth complete.

Orbital calls GitHub API to:
1. Create a repo named `<project-name>` (private by default, public toggle visible)
2. Initialize with: README.md, .gitignore (matching detected stack), LICENSE picker
3. Create `main` branch, set as default
4. Create labels: `enhancement`, `bug`, `agent-work`, `human-review`, `risk:low/med/high/critical`
5. Create initial GitHub Actions workflow `.github/workflows/ci.yml` for the detected stack:
   - Node.js: lint + typecheck + test + build matrix
   - Python (if ever): same shape adapted
   - Go: vet + test + build
6. Set up GitHub webhook pointing at Orbital's `/webhook/github` (using the operator's hub URL or local URL)
7. Generate first commit: scaffold project from selected stack (Vite+React+Tailwind v4 default; or whatever stack the vision implied)
8. Emit `GitRepoProvisioned` event

UI shows:
```
Setting up your GitHub repository...
  ✓ Created mwitt/apprentice (private)
  ✓ Initialized with README + .gitignore + MIT LICENSE
  ✓ Added 7 labels
  ✓ Configured CI workflow (Node.js + TypeScript)
  ✓ Webhooked to your Orbital install
  ✓ First commit pushed
```

### A-step: Teach the system
After board + repo exist, Orbital writes the project-specific glue so persona briefs and skills know how to operate THIS project's SDLC.

1. **Project CLAUDE.md** — generated from vision + chosen stack + detected conventions. Committed to repo. References:
   - Project's stack (e.g., "TypeScript ESM, Tailwind v4, Drizzle ORM")
   - Project's coding conventions (from the chosen template + user choices)
   - Project's SDLC: "tickets live in Monday board <id>; PRs via GitHub Actions; review by..."
2. **Project memory seed** (Round 6 #4) — initial entries:
   - `decision`: "We chose <stack> because <vision excerpt>"
   - `convention`: each style choice the user made
   - `glossary`: terms from the vision document
3. **Persona brief extension** — every persona's brief, when working on this project, automatically loads the project CLAUDE.md + top-N memory entries. (Already wired by Round 6 #4 — this onboarding just seeds the data.)
4. **Skill bundle config** — write `~/.orbital/projects/<project-id>/skills.json` listing which skills are active for this project (pulled from defaults + user choices: e.g., "include design-fidelity skill if frontend project").
5. Emit `ProjectSDLCConfigured` event with all of the above as payload.

UI shows:
```
Teaching your system how to work on this project...
  ✓ Generated project CLAUDE.md (committed to repo)
  ✓ Seeded 14 memory entries (3 decisions, 8 conventions, 3 glossary)
  ✓ Configured 11 skills for this project's tier
  ✓ Persona briefs now include project context
```

### A-step: First sprint draft
- PM agent (using Sonnet via Round 6 #8 routing) reads vision + freshly-seeded memory + creates 4-6 starting tickets
- Tickets written to the new Monday board with proper Workflow Status + Risk Tier + Estimate
- Cost forecast (Round 6 #5) shown: "Sprint 1 forecast: $8.50 / $20 cap"
- Operator: "Launch sprint" / "Edit before launch" / "Skip — I'll plan manually"

### A-step: Done
Summary card with full audit:
```
You're set up. Here's what just happened:

PROJECT
  ✓ Project "Apprentice" created
  ✓ Vision document locked (5 ACs, 3 goals, 2 non-goals)

INFRASTRUCTURE
  ✓ Monday board "Apprentice — SDLC" created (12 columns, 9 statuses)
  ✓ GitHub repo mwitt/apprentice created (private, MIT)
  ✓ GitHub Actions CI configured
  ✓ Webhook pointed at this Orbital install

SYSTEM TAUGHT
  ✓ Project CLAUDE.md generated and committed
  ✓ 14 memory entries seeded
  ✓ Persona briefs ready for this project

CREDENTIALS
  ✓ Anthropic key validated (Tier 2)
  ✓ GitHub connected (mwitt)
  ✓ Monday connected (workspace: Apogee)

POLICIES
  ✓ Mode: Semi-autonomous
  ✓ Budget: $20/sprint, $100/week

WORK
  ✓ Sprint 1 drafted: 4 tickets, est. $8.50, ~2hr

[Launch Sprint 1]  [Watch the Live Inspector]  [Tour the UI]
```

## Flow B — Existing project (Orbital LEARNS the SDLC)

The mirror image: user already has a Monday board and a GitHub repo. Orbital reads everything, infers the SDLC, asks for confirmation where ambiguous, then teaches itself.

### B-step: Connect inputs
- "Sign in with GitHub" → OAuth → repo picker → select existing repo
- Monday: paste API token + workspace picker → board picker (or "I have multiple, pick later")

### B-step: Codebase analysis
Static analysis:
- Detect stack from `package.json` / `Cargo.toml` / `go.mod` / `pyproject.toml`
- Count tests, identify test runner (Vitest/Jest/Pytest/etc)
- Identify CI: read `.github/workflows/*.yml`
- Detect commit-message convention (regex over recent history)
- Detect branch model (main only? gitflow? feature branches?)

LLM-assisted analysis (uses Claude via existing driver layer):
- Read README.md → extract project goal + audience for memory seed
- Read `docs/decisions/*.md` (ADRs) → import each as a `decision` memory entry
- Read recent 20 PR descriptions → infer review conventions (`convention` entries)
- Sample 10 random source files → infer code conventions (`convention` entries)
- Read top 50 issues/items → categorize: enhancement / bug / chore / docs

This step is the killer feature. Real Claude calls (~$0.50–1.00 per onboarding); show the cost upfront before the user clicks "Analyze."

UI:
```
Analyzing mwitt/apprentice (this will use ~$0.85 of your Anthropic budget)
  [Cancel]  [Continue]

Once running:
  ✓ Detected stack: Node.js · TypeScript · React 18 · Tailwind v4
  ✓ Found tests: Vitest (47 unit · 12 integration · 3 e2e)
  ✓ Found CI: GitHub Actions (3 workflows: ci.yml, release.yml, security.yml)
  ✓ Inferred commit style: Conventional Commits (feat:/fix:/chore:/docs:)
  ✓ Branch model: trunk-based (main + feature/*)
  ✓ Read README.md → extracted project intent
  ✓ Read 3 ADRs → importing as decisions
  ✓ Sampled 10 source files → inferred 7 conventions
  ✓ Categorized 47 open items → 12 enhancements, 8 bugs, 27 other

Continue? [Yes, looks right] [Let me adjust]
```

### B-step: Monday board mapping
The existing board has unknown column shapes. Orbital uses Round 5's `mapping.resolve` flow:
1. Discover columns via Monday API
2. Heuristic + LLM mapping: which column = AC, Workflow Status, Risk Tier, etc.
3. Show proposed mapping with confidence per column
4. User confirms or adjusts

UI:
```
Mapping your Monday board to Orbital's SDLC...

  Column "Status"            → Workflow Status      [✓ Strong match]
  Column "Description"       → Acceptance Criteria  [✓ High confidence]
  Column "Severity"          → Risk Tier            [✓ Inferred from values]
  Column "Effort"            → Estimate             [✓ Inferred from values]
  Column "Owner"             → Author               [✓ People column]
  Column "GitHub Link"       → PR Link              [✓ Pattern match]
  Column "Test Plan"         → ?                    [Suggest: leave alone]

Status value mapping:
  "To Do"        → M0 Backlog
  "In Progress"  → M3 In Progress
  "Code Review"  → M4 In Review
  "QA"           → M5 QA
  "Done"         → M8 Closed

  3 of your 9 statuses don't have direct Orbital equivalents. Pick:
    "Blocked"      → [Map to: <picker>]  Default: leave external, pause Orbital tracking
    "Deferred"    → [Map to: <picker>]
    "Wontfix"     → [Map to: M8 Closed (with reason="wontfix")]

[Confirm mapping]  [Adjust]
```

After confirmation: write `board_mappings` row, persist column-id-to-Orbital-concept lookup. From this point, persona-driven Monday writes use the user's board with the user's columns — never bypass the mapping.

### B-step: Memory seed (from inferred conventions)
Same as Flow A's seeding step, but content is inferred from the codebase rather than provided by the user. Each entry shown for confirmation/edit before commit.

### B-step: Backlog import (optional)
- Show Monday items + GitHub issues categorized
- User picks which become starting backlog
- Items moved to M2 Ready in Monday + linked into Orbital's `tasks` table

### B-step: Sprint plan offer
PM agent uses memory + imported backlog → drafts a sprint. Same review-and-launch screen as Flow A.

### B-step: Done
Summary tailored to the import:
```
Orbital is now running on your existing project.

ANALYZED
  ✓ Codebase: TypeScript/React project, 47 source files
  ✓ Existing tests: Vitest, 62 total
  ✓ CI: 3 GitHub Actions workflows
  ✓ Conventions: Conventional Commits, trunk-based, Pino logging
  ✓ ADRs imported: 3 entries

LEARNED
  ✓ 14 memory entries seeded from your codebase
  ✓ Monday board mapped (12 of 12 columns understood)
  ✓ 9 status values mapped to Orbital SDLC

READY
  ✓ Sprint 1 drafted from imported backlog: 5 tickets, est. $11.20

[Launch Sprint 1]  [Adjust mapping]  [View imported memory]
```

## Flow C — Join a team hub

(Round 7 capability — keep brief here, full design in Round 7-03/07.)

3-step flow: paste invite URL → register install → connect local Anthropic key → land on team Dashboard.

## Flow D — Sample data sandbox

For "just exploring" path. No creds, no Anthropic spend.

- Pre-populated sample project ("Acme Widgets — sample")
- Sample agents use a deterministic stub driver (the `MockDriver` from drivers/ — write one if it doesn't exist; cleanly separated from production drivers; only loadable when `ORBITAL_SAMPLE_MODE=on`)
- Real UI flows, fake data
- Persistent banner: "You're in sample mode. Switch to a real project anytime."
- Conversion CTA: "Ready to set up your real project? [Start →]"

## Cross-cutting design decisions

These are the "leave nothing to the imagination" specifics:

1. **Inline real-time validation.** Every field validates on blur. Bad Anthropic key → red text the moment they tab out, with specifics ("Anthropic keys are 109 chars; this is 47").
2. **Smart defaults VISIBLE.** "$20/sprint, $100/week" appears on the screen, not buried in a settings page.
3. **"Why?" expandables on every choice.** Mode selection, status mapping defaults, etc.
4. **Skip with a recovery path named.** "Skip — you can do this later in Settings → Models."
5. **Recovery from failure.** Back button always works; entered data preserved; failed connections retry without retyping.
6. **Time estimates per step.** "~2 min" / "~30 sec" on every screen.
7. **Persistent "Tour" button.** After onboarding, lives in topbar permanently for guided refresh.
8. **Real progress, not animation.** "Creating board..." shows actual API calls completing, not a spinner.
9. **Empty states with clear CTAs everywhere post-onboarding.**
10. **Cost transparency.** Anything costing real money tells you before you click.

## Tech stack for the wizard
- React Hook Form + Zod for form state + validation (already used in Round 6 #1's settings forms)
- TanStack Query for data fetching (already in use)
- A new `OnboardingShell` component with a step-machine pattern (xstate optional, plain reducer fine)
- Three flow components: `<NewProjectFlow>`, `<ExistingRepoFlow>`, `<JoinHubFlow>`, `<SampleDataFlow>`
- Backend: tRPC routers for all the discovery/provisioning operations (`onboarding.createMondayBoard`, `onboarding.createGitRepo`, `onboarding.analyzeCodebase`, etc.)

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| NEW `onboarding/` | `onboarding/{flows.ts,monday-provisioner.ts,github-provisioner.ts,codebase-analyzer.ts,memory-seeder.ts,system-teacher.ts,sample-data.ts}` | The new domain |
| `db/migrations/0029_onboarding_state.sql` | NEW | `onboarding_sessions` table for resumable progress |
| `events/types.ts` | extend | `OnboardingStarted`, `MondayBoardProvisioned`, `GitRepoProvisioned`, `CodebaseAnalyzed`, `ProjectSDLCConfigured`, `OnboardingCompleted`, `OnboardingAbandoned` |
| `personas/brief.ts` | extend | Brief builder loads project CLAUDE.md + project memory (Round 6 #4 already wires memory; this confirms project CLAUDE.md is in the brief) |
| `trpc/routers/onboarding.ts` | NEW | Procedures for every step |
| `trpc/routers/projects.ts` | existing | `projects.create({...})` accepts new optional `provisioning: { monday: bool, github: bool }` |
| `personas/anthropic-driver.ts` (existing wrapper) + `drivers/mock.ts` (NEW) | new | The `MockDriver` for sample mode; only registered when `ORBITAL_SAMPLE_MODE=on` |
| UI: `pages/Welcome.tsx` (rebuild) + new flow components + `components/features/onboarding/` | NEW + extend | Full wizard surface |

## Acceptance criteria
1. Flow A end-to-end on a fresh install: vision lock → Monday board created (verify via Monday API call) → GitHub repo created (verify via GitHub API call) → CLAUDE.md committed to repo (verify via git fetch + read) → memory entries seeded (verify rows in `project_memory_entries`) → first sprint drafted (verify Monday tickets) — all in one wizard run.
2. Flow B end-to-end on an existing repo: codebase analyzed → Monday board mapping correct (verify `board_mappings` row + column IDs match) → 14+ memory entries seeded → sprint drafted from imported backlog.
3. Flow C: invite URL → laptop registered → land on team Dashboard with team's existing data visible (Round 7 capability — placeholder OK if Round 7 not yet shipped, but the flow component must exist).
4. Flow D: sample mode boots without any real creds; UI is fully functional; agents use MockDriver and produce realistic-looking but fake output; conversion CTA visible.
5. Inline validation: bad Anthropic key → specific error within 200ms.
6. Resume: refresh mid-onboarding → return to same step with same data.
7. Idempotency: re-running flow A with same project name → "this project already exists; pick another or open existing."
8. Cost transparency: pre-flight cost estimate before any LLM-using step (codebase analysis); user must explicitly accept.
9. Telemetry: `OnboardingCompleted` event includes time-per-step + step-abandonment data.
10. Persistent Tour button: lives in topbar after onboarding; click → guided overlay.

## Hard-stop grep checks
```
grep -rE "from '\.\.?/onboarding/" packages/orchestrator/src/trpc/routers/onboarding.ts
grep -E "MondayBoardProvisioned|GitRepoProvisioned|ProjectSDLCConfigured" packages/orchestrator/src/events/types.ts
grep -E "NewProjectFlow|ExistingRepoFlow|JoinHubFlow|SampleDataFlow" packages/ui/src/pages/Welcome.tsx
grep -E "MockDriver|sample_mode" packages/orchestrator/src/drivers/ -r
ls packages/orchestrator/src/db/migrations/0029_onboarding_state.sql
```

## Decisions made (per "no questions, best judgement")
- Codebase analyzer: hybrid (static + LLM); LLM step is opt-in with explicit cost estimate before starting
- Sample data: deterministic MockDriver, no real LLM calls
- Defaults: Semi-autonomous mode, $20/sprint cap, Conventional Commits, trunk-based

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round9-onboarding-overhaul]`
