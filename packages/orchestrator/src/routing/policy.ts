/**
 * Policy loader — loads and validates the routing policy.
 *
 * Per TRD-08 §5.1: the policy is a TS file loaded at orchestrator boot.
 * This module validates the default policy and exposes a loader for the DB-persisted policy.
 */

import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import type { DB } from '../db/client.js'
import { routingPolicies } from '../db/schema/routing.js'
import { logger } from '../config/logger.js'
import type { RoutingPolicy } from './types.js'
import { RoutingPolicySchema } from './types.js'

// ---------------------------------------------------------------------------
// Default policy
// ---------------------------------------------------------------------------

/** Imported from config/routing-policy.default.ts */
let _defaultPolicy: RoutingPolicy | null = null

export async function loadDefaultPolicy(): Promise<RoutingPolicy> {
  if (_defaultPolicy) return _defaultPolicy

  // Dynamic import from an external config path (outside rootDir).
  // Use Function constructor to prevent TS from statically resolving the import.
  try {
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const dynamicImport = new Function('path', 'return import(path)') as (path: string) => Promise<unknown>
    const configPath = new URL('../../../../config/routing-policy.default.js', import.meta.url).href
    const mod = await dynamicImport(configPath) as Record<string, unknown>
    const raw = mod['default'] ?? mod['policy']
    _defaultPolicy = RoutingPolicySchema.parse(raw)
    return _defaultPolicy
  } catch {
    // Fallback: return the hardcoded default defined below
    logger.warn('routing policy file not found; using built-in default')
    _defaultPolicy = BUILT_IN_DEFAULT_POLICY
    return _defaultPolicy
  }
}

/** Reset for tests */
export function resetPolicyCache(): void {
  _defaultPolicy = null
}

// ---------------------------------------------------------------------------
// DB persistence helpers
// ---------------------------------------------------------------------------

const SYSTEM_ACTOR = { type: 'system', component: 'orchestrator' }

/**
 * Load the active routing policy from the DB.
 * Returns null if no policy is active.
 */
export async function loadActivePolicyFromDb(db: DB): Promise<RoutingPolicy | null> {
  const rows = await db
    .select()
    .from(routingPolicies)
    .where(eq(routingPolicies.isActive, true))
    .limit(1)

  const row = rows[0]
  if (!row) return null

  try {
    return RoutingPolicySchema.parse(row.policy)
  } catch (err) {
    logger.error({ err }, 'loadActivePolicyFromDb: active policy failed schema validation')
    return null
  }
}

/**
 * Upsert the default policy into the DB if no active policy exists.
 * Returns the DB version number for the active policy.
 */
export async function ensureActivePolicyInDb(db: DB, policy: RoutingPolicy): Promise<number> {
  const existing = await loadActivePolicyFromDb(db)
  if (existing) {
    // Return current version
    const rows = await db
      .select()
      .from(routingPolicies)
      .where(eq(routingPolicies.isActive, true))
      .limit(1)
    return rows[0]?.version ?? 1
  }

  // Insert new active policy
  const policyId = uuidv7()
  const version = 1

  await db.insert(routingPolicies).values({
    policyId,
    version,
    contentHash: 'default',
    policy: policy as unknown as Record<string, unknown>,
    isActive: true,
    loadedFromPath: 'built-in',
    loadedByActor: SYSTEM_ACTOR,
    justification: 'Initial default policy loaded at boot',
  })

  logger.info({ version }, 'ensureActivePolicyInDb: inserted default policy')
  return version
}

// ---------------------------------------------------------------------------
// Built-in default policy (used when config file is absent)
// ---------------------------------------------------------------------------

const BUILT_IN_DEFAULT_POLICY: RoutingPolicy = {
  schema_version: 1,
  description: 'Orbital v1 built-in default routing policy.',
  persona_affinities: [
    { persona_id: 'pm', base_model: 'claude-opus-4-6', rationale: 'Vision and product judgment.' },
    { persona_id: 'architect', base_model: 'claude-opus-4-6', rationale: 'System-level design.' },
    { persona_id: 'principal-dev', base_model: 'claude-opus-4-6', rationale: 'Cross-cutting decisions.' },
    { persona_id: 'security', base_model: 'claude-opus-4-6', rationale: 'Threat modeling, sensitive review.' },
    { persona_id: 'sr-dev', base_model: 'claude-sonnet-4-6', rationale: 'Default implementation work.' },
    { persona_id: 'verifier', base_model: 'claude-sonnet-4-6', rationale: 'Cheap enough to run on every output, capable enough to catch real issues.' },
    { persona_id: 'retro-analyst', base_model: 'claude-sonnet-4-6', rationale: 'Pattern-finding over a sprint of events.' },
    { persona_id: 'qa', base_model: 'claude-sonnet-4-6', rationale: 'Test writing; balanced capability.' },
    { persona_id: 'em', base_model: 'claude-sonnet-4-6', rationale: 'Management tasks; balanced capability.' },
    { persona_id: 'jr-dev', base_model: 'claude-haiku-4-5', rationale: 'Scaffolding, simple CRUD, lint fixes.' },
    { persona_id: 'scrum-master', base_model: 'claude-haiku-4-5', rationale: 'Process orchestration; cheap.' },
  ],
  risk_class_rules: [
    { risk_class: 'low', min_capability_tier: 'simple' },
    { risk_class: 'standard', min_capability_tier: 'default' },
    { risk_class: 'high', min_capability_tier: 'complex' },
    { risk_class: 'critical', min_capability_tier: 'complex', pin_model: 'claude-opus-4-6' },
  ],
  retry_escalation: [
    { retry_depth: 1, bump_tiers: 1 },
    { retry_depth: 2, bump_tiers: 2 },
  ],
  latency_rules: [
    { if_below_ms: 5_000, prefer_tier: 'default' },
    { if_below_ms: 1_500, prefer_tier: 'simple' },
  ],
  default_escalation_policy: {
    on_failure: 'escalate_one_tier',
    max_retries: 3,
    escalate_after: 1,
  },
  default_task_caps_usd_micros: {
    low: 100_000,
    standard: 1_000_000,
    high: 5_000_000,
    critical: 20_000_000,
  },
}

export { BUILT_IN_DEFAULT_POLICY }
