/**
 * hub-client/types.ts — Shared types for the Hub HTTP+WS client.
 *
 * Round 7-02 — Local-vs-Hub Split in Local Orbital
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 *
 * These types mirror what the hub tRPC routers return so the local proxy can
 * satisfy the same TypeScript contracts without importing the full router tree
 * at runtime.
 */

// ---------------------------------------------------------------------------
// Hub connection status
// ---------------------------------------------------------------------------

export type HubConnectionStatus = 'connected' | 'connecting' | 'disconnected' | 'error'

export interface HubStatus {
  status: HubConnectionStatus
  /** ISO timestamp of the last successful response from the hub. */
  lastSyncAt: string | null
  /** Hub URL as configured in ORBITAL_HUB_URL. null when not configured. */
  hubUrl: string | null
  /** Non-null when status is 'error'. */
  errorMessage: string | null
}

// ---------------------------------------------------------------------------
// Hub event append shape
// ---------------------------------------------------------------------------

export interface HubEventInput {
  aggregate_id: string
  aggregate_type: string
  event_type: string
  payload: Record<string, unknown>
  actor: Record<string, unknown>
  capability_id?: string
  trace_id: string
  occurred_at: string
  schema_version: number
  /** Tenant ID — the hub requires explicit scoping on every write. */
  tenant_id: string
}

export interface HubEventEnvelope extends HubEventInput {
  event_id: string
  ingested_at: string
}

// ---------------------------------------------------------------------------
// Hub task shape (subset used by scheduler proxy)
// ---------------------------------------------------------------------------

export interface HubTask {
  task_id: string
  sprint_id: string | null
  title: string
  description: string | null
  state: string
  ordering: number
  persona_id: string
  risk_class: string
  attempt_count: number
  retry_budget: number
  wall_clock_timeout_ms: number
  token_budget: number
  declared_write_paths: string[]
  created_at: string
  updated_at: string
  tenant_id: string
  assigned_install_id: string | null
}

// ---------------------------------------------------------------------------
// Hub worker shape (for agentWorkers dual-write)
// ---------------------------------------------------------------------------

export interface HubWorkerRegistration {
  worker_id: string
  task_id: string
  install_id: string
  pid: number | null
  state: string
  started_at: string
  /** Used to identify which hub tenant this worker belongs to. */
  tenant_id: string
}

// ---------------------------------------------------------------------------
// Hub proxy response envelope
// ---------------------------------------------------------------------------

export interface HubProxyOk<T> {
  ok: true
  data: T
}

export interface HubProxyErr {
  ok: false
  status: number
  message: string
}

export type HubProxyResult<T> = HubProxyOk<T> | HubProxyErr

// ---------------------------------------------------------------------------
// Hub client options
// ---------------------------------------------------------------------------

export interface HubClientOptions {
  /** Hub base URL, e.g. https://orbital.team.dev. No trailing slash. */
  hubUrl: string
  /** Tenant ID to set on outbound requests. */
  tenantId: string
  /** Timeout in ms for HTTP requests. Default 10_000. */
  timeoutMs?: number
}
