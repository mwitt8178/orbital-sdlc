/**
 * trpc/routers/scheduler-ref.ts — DI registry for the live Scheduler.
 *
 * Extracted into its own module to avoid a circular import between
 * `trpc/routers/index.ts` (which would otherwise host the registry) and
 * `trpc/routers/vision.ts` (which needs to read it on every procedure call).
 *
 * Boot calls `registerScheduler` once at startup. Routers and other services
 * call `getRegisteredScheduler()` to lazy-resolve the live instance. If boot
 * has not yet wired the Scheduler (e.g. a test that bypasses the DI graph),
 * `getRegisteredScheduler()` returns `null` and the caller is expected to
 * gracefully degrade.
 */

import type { Scheduler } from '../../orchestration/scheduler.js'

let _scheduler: Scheduler | null = null

export function registerScheduler(scheduler: Scheduler): void {
  _scheduler = scheduler
}

export function getRegisteredScheduler(): Scheduler | null {
  return _scheduler
}

/** Test helper: clear the registered Scheduler. */
export function _clearRegisteredSchedulerForTest(): void {
  _scheduler = null
}
