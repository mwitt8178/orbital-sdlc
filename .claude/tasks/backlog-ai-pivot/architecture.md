# Architecture: Backlog AI-Pivot — Thin Visualization Layer

Run-id: backlog-ai-pivot
Persona: Engineer-Principal · Opus
Date: 2026-05-01
Confidence: 96

## Goal

Reposition the Backlog page from a Monday-clone (filters, drag-and-drop, bulk
ops, ticket-creation modals) to an **AI-assisted thin visualization layer** that
surfaces orchestration-specific metadata on top of Monday's authoritative
project board. Primary affordance becomes a natural-language ticket creator;
secondary creation is a small "Manual" fallback for epics.

## Bounded contexts touched

- **`backlog`** (orchestrator) — additive: new `parseAndCreate` procedure +
  templated NL parser module. Existing Story/Epic mutation procedures remain
  unchanged. Service layer is not touched (parser composes existing
  `createEpic` / `createStory`).
- **`vision`** (orchestrator) — read-only: parser pulls locked vision content
  through `VisionService.getDocument` + `getVersion` to add product context to
  proposals. No mutations.
- **`ui/backlog`** (UI) — entirely re-shaped: NLTicketCreator becomes the
  primary creation surface; BacklogFilters / DnD / bulk-select / form modals
  removed.

No DB schema changes, no migrations, no new event types. The parser uses the
existing `EpicCreated` and `StoryCreated` event flow; the audit trail is
preserved by routing through `BacklogService.createEpic` / `createStory` which
already emit those events.

## Aggregate boundaries

- **Story aggregate** (unchanged) — the parser's "story" branch creates a
  story under a chosen / suggested epic via `BacklogService.createStory`.
  All invariants (epic must exist, AC list non-empty, status="backlog") are
  enforced by the existing code path.
- **Epic aggregate** (unchanged) — the parser's "epic" branch creates a new
  epic via `BacklogService.createEpic` against the locked vision version.
- **Bug = Story with `defect_id` populated** — same aggregate, same code
  path. The parser's "bug" branch synthesizes a `defect_id = uuidv7()` and
  `persona_of_record = 'qa'` when bug-language is detected.

The NL parser is a **stateless function**, not an aggregate. It produces a
typed `Proposal` value. The UI confirms the proposal, then issues a normal
`backlog.epics.create` or `backlog.stories.create` mutation. The
`parseAndCreate` server procedure exists as a single round-trip convenience
that runs parse + create in one server call (so the templated parser has
the locked vision content readily available without a second client call).

## Event flow

NL submit → `backlog.parseAndCreate({ prompt, kind, vision_document_id })`
  1. Resolve locked vision content via `VisionService.getVersion(documentId)`.
  2. Run parser: `parsePrompt(prompt, visionContext, kind?) -> Proposal`.
  3. If `confirm: false` (default for the dual-step UI flow): return Proposal.
  4. If `confirm: true`: persist by routing to `createEpic` or `createStory`,
     emit `EpicCreated` / `StoryCreated` (existing path).

UI Flow: parse → render proposal → user edits inline → user clicks Create →
new mutation `backlog.parseAndCreate({ ..., confirm: true })` OR direct
`backlog.epics.create` / `backlog.stories.create` from the edited proposal.

To keep the surface area minimal and reuse existing audit/event flow, the
**confirm path uses the existing `epics.create` / `stories.create` procedures**
directly. `parseAndCreate` is a pure parsing query (returns a Proposal).

## IAM diff

None. No new capabilities, no new IAM policies, no new principals. The new
procedure is `publicProcedure` (consistent with existing backlog routes; the
UI runs in-browser as a `user` actor and does not require additional checks
in single-tenant local-first scope).

## DSQL schema diff

None. No new tables, columns, indexes, or constraints. The parser composes
existing schema via `BacklogService` and `VisionService`.

## Blast radius

- **UI**: only files under `packages/ui/src/components/features/backlog/` +
  `pages/Backlog.tsx` + `store/backlog.ts`. Other UI feature directories
  (projects, ceremonies, comms, vision, uat, retro, dashboard, channels,
  admin, settings, audit) are untouched.
- **Orchestrator**: only adds files under `src/backlog/nl-parser.ts` and
  one additive procedure to `src/trpc/routers/backlog.ts`. No mutation to
  `service.ts`, schema, events, or sibling routers.
- **Tests**: deletes 3 modal files; adds 4 new test files; modifies the
  Playwright spec.

Sibling agents (Setup-vision-immersion, CeremonyScheduler, Vision
auto-decompose, Hygiene, Ceremonies UI) write to disjoint directories
(`components/features/projects`, `comms/*`, `vision/auto-decompose*`,
`admin/hygiene*`). No file conflicts.

## Rollback strategy

All changes are within a single feature branch. The pivot is reversible by
git revert: NL parser module deletion + UI restoration of the deleted
modals. Because no schema migration runs and no events change shape, there
is no DB rollback step — existing `EpicCreated` / `StoryCreated` events
emitted by the new flow are bit-for-bit identical to those emitted by the
old form modals.

## Key implementation decisions

1. **`monday_subitem_id` vs `monday_item_id`**: the Story schema uses
   `monday_item_id`. The brief's reference to `monday_subitem_id` is
   honoured by reading whichever column is present on a story; "Open in
   Monday" link surfaces when either id is set. Implementation: read
   `monday_item_id` (the actual column name) and link to
   `https://${ORG}.monday.com/boards/${boardId}/pulses/${itemId}`. Org
   slug is unknown at the install level — for now we use a conservative
   fallback that uses just `boardId` + `itemId` if no org subdomain is
   configured.
2. **Parser modes**: dev-mode uses pure-Node templated heuristics (no
   network). Production mode (when `ANTHROPIC_API_KEY` is set) uses a
   small Haiku call. Both paths return the same `Proposal` shape, so the
   UI is unaware which engine produced the proposal.
3. **No DOM tests for the UI component**: this codebase does not include
   `@testing-library/react`. Per the existing pattern (`KpiCards.test.tsx`),
   pure helpers are extracted into a separate module
   (`nl-ticket-creator-logic.ts`) and unit-tested directly. The component
   stays thin and presentational.
4. **`SearchInput.tsx` placement**: added inline at the top of the epic
   accordion section in `Backlog.tsx`, not as a separate component file —
   the brief allows either, and inline keeps the file count smaller.
   On reflection: the brief explicitly lists `SearchInput.tsx` as a NEW
   file; created as a tiny dedicated component to honour that.
5. **`backlog.parseAndCreate` semantics**: this is a `query` (not a
   mutation) when `confirm` is false (the default), because the parser
   is a pure read of vision context + prompt classification. It becomes a
   `mutation` if we ever support one-shot create. For this PR we ship
   query-only — UI does parse → confirm → existing create mutation. This
   keeps idempotency simple and makes proposal editing trivial.

## Non-goals (explicitly out of scope)

- Streaming the proposal token-by-token (UI polishes can come later).
- Tracking parser-generated vs user-edited fields for analytics.
- Server-side typo correction or grammar normalization.
- Multi-language NL support — English only for this pivot.
- LLM-driven AC quality scoring (separate Vision auto-decompose agent
  owns AC generation depth).

## Done criteria

Mirrors brief's binary criteria. All eight items are programmatically
testable; the Playwright spec asserts the visible UX changes; the unit
tests cover all parser keyword heuristics; the integration test covers
the `parseAndCreate` round trip including vision context resolution.
