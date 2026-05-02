/**
 * admin/types.ts — Shared types for the admin tRPC router.
 *
 * Zod schemas are defined alongside the procedures in trpc/routers/admin.ts;
 * this module holds plain TypeScript interfaces that are used internally and
 * may be re-exported for tests.
 */

export interface AdminAuthDecision {
  /** True when the request is allowed to call admin.* mutations. */
  allowed: boolean
  /**
   * Reason code surfaced to clients on denial. One of:
   *   AUTH_OK              — request authenticated by header or open dev mode
   *   AUTH_OPEN_DEV        — open mode (NODE_ENV=development, no token configured)
   *   AUTH_MISSING_TOKEN   — token required but request did not provide one
   *   AUTH_BAD_TOKEN       — token provided but did not match
   */
  reasonCode: 'AUTH_OK' | 'AUTH_OPEN_DEV' | 'AUTH_MISSING_TOKEN' | 'AUTH_BAD_TOKEN'
  /** Optional human-readable detail. Never includes the token itself. */
  detail?: string
}

export interface SubsystemHealth {
  /** Component name — e.g. 'database', 'ws_hub', 'mcp_gateway'. */
  name: string
  /** Status pill color: emerald=ok, amber=degraded, rose=down. */
  status: 'ok' | 'degraded' | 'down'
  /** Optional last-checked-at timestamp (ISO8601). */
  lastCheckedAt?: string
  /** Optional human-readable detail. */
  detail?: string
}

export interface MetricSnapshot {
  /** Worker count from agent_workers (current active+idle). */
  activeWorkers: number
  /** Total capability denials across the lifetime of this install. */
  capabilityDenials: number
  /** Total cost-tracked tokens for the active sprint, in USD. May be 0 if no sprint active. */
  sprintCostUsd: number
  /** Configured budget for the active sprint, in USD. May be null. */
  sprintBudgetUsd: number | null
  /** Number of completed audit exports in the lifetime of this install. */
  exportsCompleted: number
  /** Total event count in audit.events. */
  totalEvents: number
}

export interface WorkerListRow {
  workerId: string
  personaId: string
  status: 'connecting' | 'active' | 'idle' | 'terminating' | 'terminated'
  taskId: string | null
  startedAt: string
  lastHeartbeatAt: string | null
  pid: number | null
  capabilityId: string
}

export interface SigningKeyRow {
  keyId: string
  keyKind: 'master' | 'sub'
  parentKeyId: string | null
  installId: string
  sprintId: string | null
  status: 'active' | 'retired' | 'archived' | 'compromised'
  createdAt: string
  activeFrom: string
  activeUntil: string | null
  privateZeroizedAt: string | null
}

export interface KeyHistoryRow {
  historyId: string
  keyId: string
  transition:
    | 'generated'
    | 'signed_sub'
    | 'rotated'
    | 'retired'
    | 'zeroized'
    | 'archived'
    | 'compromised'
  transitionAt: string
}

export interface BackupListRow {
  /** File path on disk (under <home>/backup/snapshots/). */
  path: string
  /** Filename only. */
  filename: string
  /** Bytes. */
  size: number
  createdAt: string
}

export interface VerifyChainResult {
  ok: boolean
  code: string
  message: string
  commitNotAttested?: boolean
  details?: {
    capability_id: string
    persona_id: string
    task_id: string
    sprint_id: string
    sub_key_id: string
    master_key_id: string
    install_id: string
    issued_at: string
    expires_at: string
  }
}
