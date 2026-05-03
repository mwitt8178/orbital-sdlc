/**
 * onboarding/flows.ts — flow state machine for the resumable wizard.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Each flow is a deterministic ordered list of steps. The OnboardingFlowService
 * persists session state to `onboarding_sessions` so refresh mid-flow returns
 * to the same step.
 *
 * Real implementations only — every state transition writes to Postgres and
 * emits a domain event. No in-memory shortcuts.
 */

import { uuidv7 } from 'uuidv7'
import { and, desc, eq } from 'drizzle-orm'
import type { Actor } from '@orbital/types'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import {
  onboardingSessions,
  type OnboardingSessionRow,
} from '../db/schema/onboarding.js'
import type {
  OnboardingStartedPayload,
  OnboardingCompletedPayload,
  OnboardingAbandonedPayload,
} from '../events/types.js'

const SENTINEL_TENANT = '00000000-0000-0000-0000-000000000000'
const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

// ---------------------------------------------------------------------------
// Flow definitions
// ---------------------------------------------------------------------------

export type OnboardingFlow = 'new_project' | 'existing_repo' | 'join_hub' | 'sample_data'

/** Time-estimate hint shown in the UI per step. Approximate, in seconds. */
export interface StepDef {
  id: string
  label: string
  estSeconds: number
}

export const FLOW_STEPS: Record<OnboardingFlow, StepDef[]> = {
  new_project: [
    { id: 'project_basics', label: 'Project basics', estSeconds: 60 },
    { id: 'connect_tools', label: 'Connect tools', estSeconds: 90 },
    { id: 'vision_intake', label: 'Vision intake', estSeconds: 180 },
    { id: 'monday_provision', label: 'Setting up Monday board', estSeconds: 30 },
    { id: 'github_provision', label: 'Setting up GitHub repo', estSeconds: 30 },
    { id: 'system_teach', label: 'Teaching the system', estSeconds: 30 },
    { id: 'mode', label: 'Mode + budget', estSeconds: 30 },
    { id: 'first_sprint', label: 'First sprint', estSeconds: 60 },
    { id: 'done', label: 'Done', estSeconds: 0 },
  ],
  existing_repo: [
    { id: 'connect_repo', label: 'Connect repo', estSeconds: 60 },
    { id: 'codebase_analysis', label: 'Codebase analysis', estSeconds: 120 },
    { id: 'board_mapping', label: 'Board mapping', estSeconds: 90 },
    { id: 'memory_seed', label: 'Seed memory', estSeconds: 60 },
    { id: 'system_teach', label: 'Teaching the system', estSeconds: 30 },
    { id: 'mode', label: 'Mode + budget', estSeconds: 30 },
    { id: 'first_sprint', label: 'First sprint', estSeconds: 60 },
    { id: 'done', label: 'Done', estSeconds: 0 },
  ],
  join_hub: [
    { id: 'invite_url', label: 'Paste invite URL', estSeconds: 30 },
    { id: 'register', label: 'Register laptop', estSeconds: 30 },
    { id: 'connect_anthropic', label: 'Connect Anthropic key', estSeconds: 60 },
    { id: 'done', label: 'Done', estSeconds: 0 },
  ],
  sample_data: [
    { id: 'load_sample', label: 'Load sample dataset', estSeconds: 15 },
    { id: 'done', label: 'Done', estSeconds: 0 },
  ],
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface StartFlowInput {
  installId: string
  flow: OnboardingFlow
  tenantId?: string
}

export interface UpdateSessionInput {
  sessionId: string
  step?: string
  patch?: Record<string, unknown>
}

export interface OnboardingFlowService {
  start(input: StartFlowInput): Promise<OnboardingSessionRow>
  /** Find the most-recent active session for an install (for resume). */
  resume(installId: string, tenantId?: string): Promise<OnboardingSessionRow | null>
  /** Find a session by id. */
  get(sessionId: string, tenantId?: string): Promise<OnboardingSessionRow | null>
  /** Advance to the next step or write patch to state_json (or both). */
  update(input: UpdateSessionInput, tenantId?: string): Promise<OnboardingSessionRow>
  complete(
    sessionId: string,
    projectId: string | null,
    tenantId?: string,
  ): Promise<OnboardingSessionRow>
  abandon(
    sessionId: string,
    reason: string,
    tenantId?: string,
  ): Promise<OnboardingSessionRow>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultOnboardingFlowService implements OnboardingFlowService {
  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
  ) {}

  async start(input: StartFlowInput): Promise<OnboardingSessionRow> {
    const tenantId = input.tenantId ?? SENTINEL_TENANT
    const sessionId = uuidv7()
    const steps = FLOW_STEPS[input.flow]
    const firstStep = steps[0]
    if (!firstStep) {
      throw new Error(`onboarding flow ${input.flow} has no steps`)
    }
    const now = new Date()
    const inserted = await this.db
      .insert(onboardingSessions)
      .values({
        sessionId,
        tenantId,
        installId: input.installId,
        flow: input.flow,
        currentStep: firstStep.id,
        status: 'active',
        stateJson: {},
        projectId: null,
        stepDurations: {},
        stepStartedAt: now,
        startedAt: now,
        updatedAt: now,
        completedAt: null,
        abandonedAt: null,
        schemaVersion: 1,
      })
      .returning()

    const row = inserted[0]
    if (!row) throw new Error('onboarding_sessions insert returned no rows')

    const payload: OnboardingStartedPayload = {
      session_id: sessionId,
      install_id: input.installId,
      flow: input.flow,
      started_at: now.toISOString(),
    }
    await this.eventStore.append({
      aggregate_id: input.installId,
      aggregate_type: 'install',
      event_type: 'OnboardingStarted',
      payload: payload as unknown as Record<string, unknown>,
      actor: SYSTEM_ACTOR,
      trace_id: uuidv7(),
      occurred_at: now.toISOString(),
      schema_version: 1,
    })

    return row
  }

  async resume(
    installId: string,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<OnboardingSessionRow | null> {
    const rows = await this.db
      .select()
      .from(onboardingSessions)
      .where(
        and(
          eq(onboardingSessions.installId, installId),
          eq(onboardingSessions.tenantId, tenantId),
          eq(onboardingSessions.status, 'active'),
        ),
      )
      .orderBy(desc(onboardingSessions.startedAt))
      .limit(1)
    return rows[0] ?? null
  }

  async get(
    sessionId: string,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<OnboardingSessionRow | null> {
    const rows = await this.db
      .select()
      .from(onboardingSessions)
      .where(
        and(
          eq(onboardingSessions.sessionId, sessionId),
          eq(onboardingSessions.tenantId, tenantId),
        ),
      )
      .limit(1)
    return rows[0] ?? null
  }

  async update(
    input: UpdateSessionInput,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<OnboardingSessionRow> {
    const existing = await this.get(input.sessionId, tenantId)
    if (!existing) {
      throw new Error(`onboarding session ${input.sessionId} not found`)
    }
    if (existing.status !== 'active') {
      throw new Error(
        `onboarding session ${input.sessionId} is ${existing.status}, cannot update`,
      )
    }

    const now = new Date()
    const updates: Partial<typeof onboardingSessions.$inferInsert> = { updatedAt: now }

    if (input.step && input.step !== existing.currentStep) {
      // Moving to a new step — record the elapsed time on the previous step.
      if (existing.stepStartedAt) {
        const elapsedMs = now.getTime() - existing.stepStartedAt.getTime()
        const prior = (existing.stepDurations as Record<string, number>) ?? {}
        prior[existing.currentStep] = (prior[existing.currentStep] ?? 0) + elapsedMs
        updates.stepDurations = prior
      }
      updates.currentStep = input.step
      updates.stepStartedAt = now
    }

    if (input.patch) {
      const merged = { ...((existing.stateJson as Record<string, unknown>) ?? {}), ...input.patch }
      updates.stateJson = merged
      // If the patch contains a project_id, lift it to the column for index access.
      if (typeof input.patch['project_id'] === 'string') {
        updates.projectId = input.patch['project_id'] as string
      }
    }

    const [row] = await this.db
      .update(onboardingSessions)
      .set(updates)
      .where(
        and(
          eq(onboardingSessions.sessionId, input.sessionId),
          eq(onboardingSessions.tenantId, tenantId),
        ),
      )
      .returning()

    if (!row) throw new Error(`onboarding session ${input.sessionId} update returned no rows`)
    return row
  }

  async complete(
    sessionId: string,
    projectId: string | null,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<OnboardingSessionRow> {
    const existing = await this.get(sessionId, tenantId)
    if (!existing) throw new Error(`onboarding session ${sessionId} not found`)
    if (existing.status === 'completed') return existing
    if (existing.status === 'abandoned') {
      throw new Error(`onboarding session ${sessionId} was abandoned`)
    }

    const now = new Date()
    // Capture remaining step duration.
    const durations: Record<string, number> = {
      ...((existing.stepDurations as Record<string, number>) ?? {}),
    }
    if (existing.stepStartedAt) {
      const elapsed = now.getTime() - existing.stepStartedAt.getTime()
      durations[existing.currentStep] = (durations[existing.currentStep] ?? 0) + elapsed
    }

    const totalMs = now.getTime() - existing.startedAt.getTime()

    const [row] = await this.db
      .update(onboardingSessions)
      .set({
        status: 'completed',
        completedAt: now,
        stepDurations: durations,
        projectId: projectId ?? existing.projectId,
        updatedAt: now,
      })
      .where(
        and(
          eq(onboardingSessions.sessionId, sessionId),
          eq(onboardingSessions.tenantId, tenantId),
        ),
      )
      .returning()

    if (!row) throw new Error(`onboarding session ${sessionId} complete returned no rows`)

    const payload: OnboardingCompletedPayload = {
      session_id: sessionId,
      install_id: existing.installId,
      project_id: row.projectId,
      flow: existing.flow as OnboardingFlow,
      step_durations: durations,
      total_duration_ms: totalMs,
      completed_at: now.toISOString(),
    }
    await this.eventStore.append({
      aggregate_id: existing.installId,
      aggregate_type: 'install',
      event_type: 'OnboardingCompleted',
      payload: payload as unknown as Record<string, unknown>,
      actor: SYSTEM_ACTOR,
      trace_id: uuidv7(),
      occurred_at: now.toISOString(),
      schema_version: 1,
    })

    return row
  }

  async abandon(
    sessionId: string,
    reason: string,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<OnboardingSessionRow> {
    const existing = await this.get(sessionId, tenantId)
    if (!existing) throw new Error(`onboarding session ${sessionId} not found`)
    if (existing.status !== 'active') return existing

    const now = new Date()
    const durations: Record<string, number> = {
      ...((existing.stepDurations as Record<string, number>) ?? {}),
    }
    if (existing.stepStartedAt) {
      const elapsed = now.getTime() - existing.stepStartedAt.getTime()
      durations[existing.currentStep] = (durations[existing.currentStep] ?? 0) + elapsed
    }

    const [row] = await this.db
      .update(onboardingSessions)
      .set({
        status: 'abandoned',
        abandonedAt: now,
        stepDurations: durations,
        updatedAt: now,
      })
      .where(
        and(
          eq(onboardingSessions.sessionId, sessionId),
          eq(onboardingSessions.tenantId, tenantId),
        ),
      )
      .returning()

    if (!row) throw new Error(`onboarding session ${sessionId} abandon returned no rows`)

    const payload: OnboardingAbandonedPayload = {
      session_id: sessionId,
      install_id: existing.installId,
      flow: existing.flow as OnboardingFlow,
      last_step: existing.currentStep,
      reason,
      step_durations: durations,
      abandoned_at: now.toISOString(),
    }
    await this.eventStore.append({
      aggregate_id: existing.installId,
      aggregate_type: 'install',
      event_type: 'OnboardingAbandoned',
      payload: payload as unknown as Record<string, unknown>,
      actor: SYSTEM_ACTOR,
      trace_id: uuidv7(),
      occurred_at: now.toISOString(),
      schema_version: 1,
    })

    return row
  }
}

export function createOnboardingFlowService(
  db: DB,
  eventStore: EventStore,
): OnboardingFlowService {
  return new DefaultOnboardingFlowService(db, eventStore)
}
