/**
 * Unit tests for metrics/prometheus.ts
 *
 * Per Phase 6B done criteria:
 * - Each metric increments correctly
 * - /metrics endpoint returns valid Prometheus text format
 *
 * Rules:
 * - Real prom-client (no mocking)
 * - Uses isolated Registry per test via resetMetrics()
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import Fastify from 'fastify'
import {
  registerMetrics,
  resetMetrics,
  incEventsTotal,
  incCapabilityDenials,
  setActiveWorkers,
  setBudgetUtilization,
  observeTaskDuration,
} from '../../../src/metrics/prometheus.js'
import { registerMetricsRoute } from '../../../src/metrics/route.js'

// Prometheus text format validation regex patterns
const HELP_PATTERN = /^# HELP \w+ .+$/m
const TYPE_PATTERN = /^# TYPE \w+ (counter|gauge|histogram|summary|untyped)$/m
const METRIC_PATTERN = /^\w+(\{[^}]*\})? \d+(\.\d+)?(e[+-]?\d+)?$/m

describe('prometheus metrics', () => {
  beforeEach(() => {
    resetMetrics()
  })

  afterEach(() => {
    resetMetrics()
  })

  describe('registerMetrics()', () => {
    it('returns a Registry instance', () => {
      const registry = registerMetrics()
      expect(registry).toBeDefined()
      expect(typeof registry.metrics).toBe('function')
    })

    it('is idempotent — returns the same registry on multiple calls', () => {
      const r1 = registerMetrics()
      const r2 = registerMetrics()
      expect(r1).toBe(r2)
    })

    it('registers all 5 expected metric names', async () => {
      const registry = registerMetrics()
      const output = await registry.metrics()

      expect(output).toMatch(/orbital_active_workers/)
      expect(output).toMatch(/orbital_events_total/)
      expect(output).toMatch(/orbital_capability_denials_total/)
      expect(output).toMatch(/orbital_budget_utilization/)
      expect(output).toMatch(/orbital_task_duration_ms/)
    })
  })

  describe('incEventsTotal()', () => {
    it('increments orbital_events_total for a given event_type', async () => {
      const registry = registerMetrics()

      incEventsTotal('TaskCreated')
      incEventsTotal('TaskCreated')
      incEventsTotal('CapabilityDenied')

      const output = await registry.metrics()

      // TaskCreated counter should be 2
      expect(output).toMatch(/orbital_events_total\{event_type="TaskCreated"\} 2/)
      // CapabilityDenied counter should be 1
      expect(output).toMatch(/orbital_events_total\{event_type="CapabilityDenied"\} 1/)
    })

    it('no-ops when registry is not initialized', () => {
      // resetMetrics was called in beforeEach; incEventsTotal should not throw
      expect(() => incEventsTotal('TaskCreated')).not.toThrow()
    })
  })

  describe('incCapabilityDenials()', () => {
    it('increments orbital_capability_denials_total', async () => {
      const registry = registerMetrics()

      incCapabilityDenials()
      incCapabilityDenials()
      incCapabilityDenials()

      const output = await registry.metrics()
      expect(output).toMatch(/orbital_capability_denials_total 3/)
    })
  })

  describe('setActiveWorkers()', () => {
    it('sets orbital_active_workers gauge', async () => {
      const registry = registerMetrics()

      setActiveWorkers(5)
      let output = await registry.metrics()
      expect(output).toMatch(/orbital_active_workers 5/)

      setActiveWorkers(2)
      output = await registry.metrics()
      expect(output).toMatch(/orbital_active_workers 2/)
    })
  })

  describe('setBudgetUtilization()', () => {
    it('sets orbital_budget_utilization gauge with sprint_id label', async () => {
      const registry = registerMetrics()

      setBudgetUtilization('sprint-abc', 0.75)

      const output = await registry.metrics()
      expect(output).toMatch(/orbital_budget_utilization\{sprint_id="sprint-abc"\} 0\.75/)
    })

    it('supports multiple sprint_id labels independently', async () => {
      const registry = registerMetrics()

      setBudgetUtilization('sprint-1', 0.3)
      setBudgetUtilization('sprint-2', 0.9)

      const output = await registry.metrics()
      expect(output).toMatch(/orbital_budget_utilization\{sprint_id="sprint-1"\} 0\.3/)
      expect(output).toMatch(/orbital_budget_utilization\{sprint_id="sprint-2"\} 0\.9/)
    })
  })

  describe('observeTaskDuration()', () => {
    it('records a value into orbital_task_duration_ms histogram', async () => {
      const registry = registerMetrics()

      observeTaskDuration(1500)
      observeTaskDuration(500)

      const output = await registry.metrics()
      // Histogram output includes _count and _sum
      expect(output).toMatch(/orbital_task_duration_ms_count 2/)
      expect(output).toMatch(/orbital_task_duration_ms_sum 2000/)
    })
  })

  describe('Prometheus text format validity', () => {
    it('output matches Prometheus text exposition format', async () => {
      const registry = registerMetrics()

      // Populate some metrics so the output is non-trivial
      incEventsTotal('TaskCreated')
      incCapabilityDenials()
      setActiveWorkers(3)
      setBudgetUtilization('sprint-x', 0.5)
      observeTaskDuration(1000)

      const output = await registry.metrics()

      // Must have # HELP lines
      expect(HELP_PATTERN.test(output)).toBe(true)
      // Must have # TYPE lines
      expect(TYPE_PATTERN.test(output)).toBe(true)
      // Must have metric sample lines: name{labels?} value
      expect(METRIC_PATTERN.test(output)).toBe(true)

      // Every # TYPE line must reference a known valid type
      const typeLines = output.split('\n').filter((l) => l.startsWith('# TYPE '))
      for (const line of typeLines) {
        expect(line).toMatch(/^# TYPE \w+ (counter|gauge|histogram|summary|untyped)$/)
      }

      // Every # HELP line must have non-empty help text
      const helpLines = output.split('\n').filter((l) => l.startsWith('# HELP '))
      for (const line of helpLines) {
        expect(line.length).toBeGreaterThan('# HELP '.length + 1)
      }
    })
  })

  describe('GET /metrics route', () => {
    it('returns 200 with text/plain content-type and valid Prometheus format', async () => {
      const registry = registerMetrics()
      incEventsTotal('SprintStarted')
      setActiveWorkers(1)

      const app = Fastify({ logger: false })
      registerMetricsRoute(app, registry)

      await app.ready()

      const response = await app.inject({ method: 'GET', url: '/metrics' })

      expect(response.statusCode).toBe(200)
      // Content-Type includes text/plain
      expect(response.headers['content-type']).toMatch(/text\/plain/)
      // Body contains Prometheus metric
      expect(response.body).toMatch(/orbital_active_workers 1/)
      expect(response.body).toMatch(/orbital_events_total\{event_type="SprintStarted"\} 1/)

      await app.close()
    })

    it('returns valid format even when no metrics have been recorded yet', async () => {
      const registry = registerMetrics()

      const app = Fastify({ logger: false })
      registerMetricsRoute(app, registry)

      await app.ready()

      const response = await app.inject({ method: 'GET', url: '/metrics' })

      expect(response.statusCode).toBe(200)
      // Must still have valid structure — at minimum the metric definitions
      expect(response.body).toMatch(/# HELP/)
      expect(response.body).toMatch(/# TYPE/)

      await app.close()
    })
  })
})
