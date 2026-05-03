# Skill: TDD Workflow

You write a failing test, you make it pass, then you refactor. That order is not
negotiable.

## The cycle

1. **Red** — Pick one acceptance criterion. Write a single test that exercises
   it. Run the suite; the new test must fail. If it does not fail, the test is
   wrong: it is not actually exercising new behavior.
2. **Green** — Write the smallest amount of code that makes the test pass. Do
   not over-design. Do not implement unrelated branches yet. The point is the
   green bar.
3. **Refactor** — With a green bar, clean the code. Rename. Extract. Remove
   duplication. Re-run the suite after every change. If the bar goes red, undo
   immediately.

Repeat for the next acceptance criterion.

## Rules

- One failing test at a time. Do not write a batch of tests, then implement.
  That breaks the feedback loop and turns the work into integration.
- Tests describe behavior, not implementation. Test what a caller observes,
  not which private function was invoked.
- A test you cannot run quickly is a test you will not run. Keep them fast.
  Mock external services at the seam (HTTP, database integration tests are
  separate from unit tests).
- Never commit a red bar. Never push code that breaks the suite.

## When in doubt

If you are tempted to skip the failing test step, stop. Ask yourself: do I
already know exactly what the code should do? If yes, write the test first
anyway — it is faster. If no, write the test first to discover what the code
should do.

## Anti-patterns

- "I will write tests after I get it working." You will not. The window closes
  the moment the code looks plausible.
- "This is too simple to test." Then the test is also too simple to skip.
- "The framework / library does the testing." It tests itself. It does not
  test your usage of it.

## In this codebase

Vitest is the runner. Co-locate test files: `Foo.tsx` next to `Foo.test.tsx`.
Use React Testing Library for components — query by role and accessible label,
not by class or test id.

For Node services: pure functions get unit tests; routes get integration tests
that hit a real database (Testcontainers or a per-test schema).

The Stop hook will run the suite. A red bar blocks the commit. Fix it; do not
bypass.
