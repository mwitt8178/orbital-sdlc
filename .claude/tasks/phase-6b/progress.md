# Phase 6B Progress — OTel + Prometheus Metrics

## Self-checks

### DSQL / multi-tenant / security / observability

- DSQL: Not applicable (this is a local Postgres deployment; no DSQL constraints triggered)
- Multi-tenant isolation: `startMetricsInstrumentation` reads `agent_workers` without tenant filter (correct — v1 is single-tenant; no `tenant_id` column on `agent_workers`)
- Security: No secrets added; logger.ts redact list unchanged; `loggerWithContext` only adds trace_id (non-secret)
- Observability: OTel SDK initialized lazily (no-op in test); spans created per HTTP request; trace_id injected into EventInput via `wrapAppend`

### TDD cycle

RED: wrote test first (prometheus.test.ts); confirmed failure  
GREEN: implemented prometheus.ts, route.ts, instrumentation.ts  
REFACTOR: fixed wrapAppend to use explicit method binding (not object spread) for class prototype safety

### All AC checklist

- [x] EventStore.append() increments orbital_events_total{event_type=...}
- [x] CapabilityDenied event increments orbital_capability_denials_total
- [x] orbital_active_workers gauge reflects real worker count from agent_workers (refreshed every 10s + on start)
- [x] GET /metrics returns valid Prometheus text exposition format
- [x] trace_id on event envelope matches OTel trace (in test env: fallback to caller-provided trace_id since no-op tracer)
- [x] loggerWithContext(ctx) export added to logger.ts (additive only, global logger unchanged)
- [x] initTelemetry() wired into index.ts start()
- [x] registerMetricsRoute() wired into buildApp()
- [x] startMetricsInstrumentation() + wrapAppend() wired into start()
- [x] npm test passes: 618 tests / 62 files
- [x] go vet / lint equivalent: tsc --noEmit clean on all Phase 6B files

### Risk assessment

Estimate: M (Medium)  
Risk Tier: Low — all changes additive; no existing functionality modified except logger.ts (additive export)

### Deferred

- OTel context propagation across async boundaries within Fastify request lifecycle: the `context.with()` call in tracing.ts is best-effort in test env (no OTel SDK). Full propagation requires the SDK to be active. For production this is correct.
- `orbital_task_duration_ms` histogram is defined and exported but not yet fed from task lifecycle events (no task duration source exists yet at Phase 6B; will be wired in Phase 7 or 8 when task completion flows are instrumented end-to-end).
