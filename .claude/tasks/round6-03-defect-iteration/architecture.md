# Round 6 — #3 Iterate-on-Defect Loop in UAT

## Persona / Risk
Engineer-Senior · Sonnet · Risk Tier: Medium · Estimate: M

## Why
`packages/orchestrator/src/uat/defects.ts` is 393 lines and exports `DefectService` / `createDefectService` / `DefaultDefectService`. But the loop *defect submitted → re-spawn author → re-PR → re-verify* doesn't exist. Defects are recorded but the system doesn't act on them. The human↔agent loop is the operator's primary touchpoint — UAT defects must drive re-dispatch.

## Depends on
Wave 2 (#1 PR loop) — re-spawn pushes a new commit to the same branch, force-updates the existing PR.

## Bounded contexts touched
| Context | Files | Change |
|--|--|--|
| `uat/defects.ts` | existing | Existing `DefectService`. Verify `submitDefect` emits `DefectReported` event. Add `getDefectsForTask(task_id)` if missing |
| `hooks` | NEW `packages/orchestrator/src/hooks/post-defect-reported.ts` | On `DefectReported`, re-open the author task with state='ready', append defect details to description |
| `orchestration/scheduler.ts` | existing | Already picks `state='ready'` tasks — no change once we re-open. Verify `worker_id` and `worktree` are reset properly on re-open |
| `orchestration/spawn.ts` | existing | On re-spawn, reuse the existing worktree (so the existing branch is preserved) — add `reuseWorktree: boolean` flag. NEW or modify existing `spawnRetry()` |
| `db schema` | additive | `tasks.iteration_count` (int, default 0); `tasks.last_defect_id` (uuid, nullable); already-existing `tasks.parent_task_id` is reused for verifier-spawn so leave alone |
| `events` | new types: `DefectReported` (already exists?), `TaskReopenedForDefect`, `IterationStarted` | Verify and add |
| `uat/service.ts` | existing | When all ACs pass after a defect-driven iteration, emit `UATResolutionVerified` |
| `trpc` | existing `uat.defects` router | Add `uat.defects.history({task_id})` + `uat.defects.markFixed({defect_id})` mutations |
| `ui` | `pages/UAT.tsx`, NEW `components/features/uat/DefectReporter.tsx`, NEW `components/features/uat/DefectTimeline.tsx`, modify `ACChecklist.tsx` | Defect-report affordances + iteration history visible |

## Event flow
```
Operator on UAT page clicks "Report defect on AC #3"
  → DefectReporter opens modal:
      - AC reference (auto-filled)
      - Reproduction steps (textarea)
      - Severity (low/med/high)
      - Suggested fix (optional)
  → submit → uat.defects.report mutation → DefectService.submitDefect(...)
    → INSERT into uat_defects table
    → emit DefectReported (aggregate=task, payload={defect_id, ac_id, severity, repro})

post-defect-reported hook
  → load author_task (the task that produced the failing AC)
  → if author_task.iteration_count >= 3:
    → emit DefectIterationLimitReached → require human escalation, do NOT re-spawn
  → else:
    → UPDATE tasks SET state='ready', iteration_count=iteration_count+1,
      last_defect_id=<defect_id>,
      description = description || '\n\n## Iteration <n>: defect feedback\n<repro>'
    → emit TaskReopenedForDefect

scheduler.tick()
  → picks the re-opened author task
  → spawns author worker, REUSING worktree (so branch is preserved)
  → author runs, makes changes, commits
  → post-task hook (Wave 2 #1)
    → git push --force-with-lease (since we're updating an existing branch)
    → existing PR auto-updates (no new PR needed — same head ref)
    → emit BranchUpdated (NEW event for this case) instead of BranchPushed
  → verifier re-runs (Round 5C path) → emits VerifierPassed/Failed
  → if VerifierPassed → emit IterationCompleted

Operator sees in UAT: "Iteration 2 of 3 in progress…" with live worker output (Wave 3 #10)
After iteration completes: AC checklist re-renders with new evidence
If operator marks the original defect "fixed" → emit DefectResolved
```

## Frontend UX
### UAT page (`pages/UAT.tsx`)
- Existing ACChecklist gets a "Report defect" link per AC (when result=fail OR even on pass — operator may disagree).
- New `<DefectTimeline taskId={task_id} />` panel below the checklist showing:
  - Iteration history: Iteration 1 → defect → Iteration 2 → resolved → Iteration 3 → in-progress
  - Per-iteration: head SHA, defects opened against this iteration, time spent, tokens spent
  - Live indicator while an iteration is running

### `DefectReporter.tsx` (modal)
- Header: "Report defect on AC: <AC text>"
- Fields:
  - Reproduction steps (markdown editor, autofocus)
  - Severity (radio: low/med/high)
  - Suggested fix (optional, markdown)
- Submit → POST → confirmation: "Defect reported. Iteration 2 will start automatically."
- If iteration_count >= 3 limit: warn "This task has reached the iteration limit. Reporting this defect will require human escalation, not auto-iteration."

### `DefectTimeline.tsx`
- Vertical timeline:
  - Each entry: iteration N badge, status (running/passed/failed), defect chips (clickable, opens defect detail), commit SHA, time, cost
  - Current iteration highlighted with pulsing indicator
- Footer: "Total iterations: N · Total tokens: M · Total cost: $X.XX"

### Backlog page
- Tasks with iteration_count > 0 show a "rerolled Nx" badge in addition to PRBadge.
- Filter chip: "Iterating" (state=ready AND iteration_count > 0).

## Acceptance criteria
1. `grep -E "post-defect-reported|onDefectReported" packages/orchestrator/src/hooks/` returns ≥1 hit; the hook is registered in registry-bootstrap.
2. Integration test:
   - Spawn fake-worker task → mark TaskCompleted (verifier passes) → submit a defect via UAT → assert task state transitions to 'ready', iteration_count=1
   - Re-spawn → fake-worker writes a "fix" file → TaskCompleted again → assert iteration_count=1, no NEW PR (push to same branch)
3. Iteration limit: 4th defect on same task → emits `DefectIterationLimitReached`, task stays in_review, NO re-spawn.
4. UI: DefectReporter modal opens from ACChecklist row, submits successfully; DefectTimeline renders iteration history with correct counts.
5. Worktree reuse: `spawn.ts` with `reuseWorktree:true` does not call `WorktreeManager.create()` again — verify via test that no new worktree dir is created.
6. End-to-end: defect-driven iteration produces a NEW commit on the SAME branch, the existing PR shows the new commit (verified via fixture GitHub HTTP responses).

## What "wired up" means
- post-defect-reported hook is registered (not just defined).
- DefectReporter is imported and rendered in `UAT.tsx`.
- DefectTimeline is imported and rendered in `UAT.tsx`.
- Force-push path uses `--force-with-lease` (NEVER `--force`) to prevent overwriting concurrent reviewer commits.

## Persona evidence prefix
`[Engineer-Sr · Sonnet · run-round6-03-defect-iteration]`
