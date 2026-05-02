/**
 * prometheus.ts — Prometheus metrics registry and metric definitions.
 *
 * Per Phase 6B spec:
 *   - orbital_active_workers     Gauge  (no labels)
 *   - orbital_events_total       Counter (label: event_type)
 *   - orbital_capability_denials_total  Counter (no labels)
 *   - orbital_budget_utilization Gauge  (label: sprint_id)
 *   - orbital_task_duration_ms   Histogram
 *
 * Uses prom-client with an isolated Registry per orchestrator instance
 * (avoids global registry collisions in test parallelism).
 *
 * Exports:
 *   - `registerMetrics(): Registry`  — creates and registers all metrics; call once
 *   - helper functions to increment counters / set gauges
 */

import { Registry, Gauge, Counter, Histogram } from 'prom-client'

// ---------------------------------------------------------------------------
// Internal singletons — reset via `resetMetrics()` in tests only
// ---------------------------------------------------------------------------

let _registry: Registry | null = null
let _activeWorkers: Gauge | null = null
let _eventsTotal: Counter | null = null
let _capabilityDenials: Counter | null = null
let _budgetUtilization: Gauge | null = null
let _taskDurationMs: Histogram | null = null

// ---------------------------------------------------------------------------
// registerMetrics — idempotent; returns the same registry on repeat calls
// ---------------------------------------------------------------------------

export function registerMetrics(): Registry {
  if (_registry) return _registry

  const registry = new Registry()

  _activeWorkers = new Gauge({
    name: 'orbital_active_workers',
    help: 'Number of agent workers currently in an active state',
    registers: [registry],
  })

  _eventsTotal = new Counter({
    name: 'orbital_events_total',
    help: 'Total number of events appended to the event store, labelled by event_type',
    labelNames: ['event_type'],
    registers: [registry],
  })

  _capabilityDenials = new Counter({
    name: 'orbital_capability_denials_total',
    help: 'Total number of capability validation denials at the MCP gateway',
    registers: [registry],
  })

  _budgetUtilization = new Gauge({
    name: 'orbital_budget_utilization',
    help: 'Current budget utilization ratio (0..1) per sprint',
    labelNames: ['sprint_id'],
    registers: [registry],
  })

  _taskDurationMs = new Histogram({
    name: 'orbital_task_duration_ms',
    help: 'Task wall-clock duration in milliseconds from start to completion',
    buckets: [100, 500, 1_000, 5_000, 15_000, 60_000, 300_000],
    registers: [registry],
  })

  _registry = registry
  return registry
}

// ---------------------------------------------------------------------------
// Helper: increment orbital_events_total
// ---------------------------------------------------------------------------

export function incEventsTotal(eventType: string): void {
  if (!_eventsTotal) return
  _eventsTotal.inc({ event_type: eventType })
}

// ---------------------------------------------------------------------------
// Helper: increment orbital_capability_denials_total
// ---------------------------------------------------------------------------

export function incCapabilityDenials(): void {
  if (!_capabilityDenials) return
  _capabilityDenials.inc()
}

// ---------------------------------------------------------------------------
// Helper: set orbital_active_workers gauge
// ---------------------------------------------------------------------------

export function setActiveWorkers(count: number): void {
  if (!_activeWorkers) return
  _activeWorkers.set(count)
}

// ---------------------------------------------------------------------------
// Helper: set orbital_budget_utilization gauge for a sprint
// ---------------------------------------------------------------------------

export function setBudgetUtilization(sprintId: string, ratio: number): void {
  if (!_budgetUtilization) return
  _budgetUtilization.set({ sprint_id: sprintId }, ratio)
}

// ---------------------------------------------------------------------------
// Helper: observe a task duration
// ---------------------------------------------------------------------------

export function observeTaskDuration(durationMs: number): void {
  if (!_taskDurationMs) return
  _taskDurationMs.observe(durationMs)
}

// ---------------------------------------------------------------------------
// Test-only: reset registry (allows multiple registerMetrics() calls in tests)
// ---------------------------------------------------------------------------

export function resetMetrics(): void {
  if (_registry) {
    _registry.clear()
  }
  _registry = null
  _activeWorkers = null
  _eventsTotal = null
  _capabilityDenials = null
  _budgetUtilization = null
  _taskDurationMs = null
}

// ---------------------------------------------------------------------------
// Accessor — returns current registry or null if not yet initialized
// ---------------------------------------------------------------------------

export function getRegistry(): Registry | null {
  return _registry
}
