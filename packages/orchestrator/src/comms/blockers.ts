/**
 * blockers.ts — BlockerService.
 *
 * Per TRD-05 §4.3, §6.2.6 (`blocker.raise`), §7.5 (state machine), §10.7
 * (routing).
 *
 * Lifecycle: raised → routed → in_resolution → resolved
 *                ↓ (retries exhausted or critical)
 *            escalated
 *
 * `raise()` writes the structured row + a `post_type='blocker'` post in the
 * originating ticket channel + emits `BlockerRaised`.
 *
 * `routeToResolver()` reads the persona resolver policy, computes the next
 * candidate, emits `BlockerRouted`, and (best-effort) calls `Scheduler.addTask`
 * to spawn a resolver worker. Phase 4B will refine the spawn handoff; for
 * Phase 3A we emit `TaskCreated` for the resolver task so the existing
 * scheduler picks it up on its next tick.
 */

import { uuidv7 } from 'uuidv7'
import { eq } from 'drizzle-orm'
import { OrbitalError } from '@orbital/types'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import type { CapabilityBundle, EventInput, Actor } from '@orbital/types'
import { blockers, type BlockerUrgency } from '../db/schema/comms-workflow.js'
import { logger } from '../config/logger.js'
import type { ChannelsService } from './channels.js'
import { canonicalChannelName } from './channels.js'

// ---------------------------------------------------------------------------
// Resolver policy
// ---------------------------------------------------------------------------

/**
 * Default routing chain per role. Customizable via constructor options.
 * If a role's chain is exhausted, escalation kicks in.
 */
export const DEFAULT_RESOLVER_CHAIN: Record<string, string[]> = {
  architect: ['architect', 'principal_engineer'],
  pm: ['pm', 'architect'],
  security_officer: ['security_officer', 'architect'],
  principal_engineer: ['principal_engineer', 'architect'],
  scrum_master: ['scrum_master', 'pm'],
  senior_developer: ['senior_developer', 'architect'],
}

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface RaiseBlockerParams {
  raisingActor: Actor
  raisingTaskId: string
  ticketId?: string
  question: string
  context: string
  requestedResolverRole: string
  urgency: BlockerUrgency
  capability?: CapabilityBundle
  justification: string
}

export interface RaiseBlockerResult {
  blockerId: string
  originPostId: string
  raisedEventId: string
}

export interface RouteResult {
  blockerId: string
  routedToRole: string
  routedToTaskId: string
  routingAttempt: number
  routedEventId: string
}

export interface BlockerService {
  raise(params: RaiseBlockerParams): Promise<RaiseBlockerResult>

  /**
   * Compute next-in-chain resolver and route. Updates blocker row state
   * (raised → routed → in_resolution) and emits BlockerRouted. If the chain
   * is exhausted, this method calls escalate() instead and returns null.
   */
  routeToResolver(blockerId: string): Promise<RouteResult | null>

  resolve(params: {
    blockerId: string
    resolutionPostId: string
    resolvedByRole: string
    actor: Actor
  }): Promise<void>

  escalate(params: {
    blockerId: string
    reason: 'routing_exhausted' | 'critical_class' | 'tie_breaker_failed'
    attachedAnalysis?: string
    actor?: Actor
  }): Promise<void>

  /**
   * Set or replace the routing callback at runtime. Phase 4B's SprintService
   * uses this to wire Scheduler-aware task spawning at sprint start.
   */
  setOnRoute(callback: BlockerServiceOptions['onRoute'] | undefined): void
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export interface BlockerServiceOptions {
  /** Override the resolver chain map. */
  resolverChain?: Record<string, string[]>
  /**
   * Optional callback fired when a routing decision selects a resolver.
   * Phase 4B's SprintService wires this to Scheduler.addTask. For 3A the
   * default emits a TaskCreated event so existing schedulers pick it up.
   */
  onRoute?: (decision: {
    blockerId: string
    resolverRole: string
    resolverTaskId: string
    raisingTaskId: string
    ticketId: string | null
  }) => Promise<void> | void
}

export class DefaultBlockerService implements BlockerService {
  private readonly resolverChain: Record<string, string[]>
  private onRoute?: BlockerServiceOptions['onRoute']

  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
    private readonly channels: ChannelsService,
    options: BlockerServiceOptions = {},
  ) {
    this.resolverChain = options.resolverChain ?? DEFAULT_RESOLVER_CHAIN
    if (options.onRoute !== undefined) this.onRoute = options.onRoute
  }

  /**
   * Replace (or set) the onRoute callback at runtime.
   *
   * Phase 4B's SprintService binds Scheduler-aware task spawning at sprint
   * start. Existing constructor-supplied callbacks are overwritten; pass
   * `undefined` to detach.
   */
  setOnRoute(callback: BlockerServiceOptions['onRoute'] | undefined): void {
    this.onRoute = callback
  }

  // -------------------------------------------------------------------------
  // raise
  // -------------------------------------------------------------------------

  async raise(params: RaiseBlockerParams): Promise<RaiseBlockerResult> {
    if (!params.justification?.trim()) {
      throw new OrbitalError('VALIDATION_REQUIRED_FIELD_MISSING', 'justification is required')
    }
    if (!params.question.trim()) {
      throw new OrbitalError('VALIDATION_INVALID_REQUEST', 'question is required')
    }

    const blockerId = uuidv7()
    const traceId = uuidv7()
    const now = new Date()

    // Determine the channel: ticket durable if ticket_id supplied, else create one
    // for the raising task id (synthetic ticket bucket).
    const channelTicket = params.ticketId ?? params.raisingTaskId
    const ensure = await this.channels.ensureChannel('ticket_durable', channelTicket, {
      createdBy: SYSTEM_ACTOR,
    })

    // Insert the blocker row first (gives us a concrete blocker_id for the post payload).
    await this.db.insert(blockers).values({
      blockerId,
      raisingActor: params.raisingActor as unknown as Record<string, unknown>,
      raisingTaskId: params.raisingTaskId,
      ticketId: params.ticketId ?? null,
      question: params.question,
      context: params.context,
      requestedResolverRole: params.requestedResolverRole,
      urgency: params.urgency,
      state: 'raised',
      routedToActor: null,
      routedToTaskId: null,
      routingAttempts: 0,
      maxRoutingAttempts: 2,
      originPostId: null,
      resolutionPostId: null,
      raisedAt: now,
      resolvedAt: null,
      escalatedAt: null,
      schemaVersion: 1,
    })

    // Post a `blocker` typed-post into the ticket's durable channel.
    const postResult = await this.channels.post(
      ensure.channelId,
      {
        postType: 'blocker',
        payload: {
          blocker_id: blockerId,
          question: params.question,
          context: params.context,
          requested_resolver_role: params.requestedResolverRole,
          urgency: params.urgency,
        },
        author: params.raisingActor,
        capabilityId: params.capability?.capability_id,
        justification: `BlockerRaised: ${params.question.slice(0, 80)}`,
        traceId,
      },
      params.capability,
    )

    // Update blocker row with origin_post_id.
    await this.db
      .update(blockers)
      .set({ originPostId: postResult.postId })
      .where(eq(blockers.blockerId, blockerId))

    // Emit BlockerRaised.
    const raisedEvent: EventInput = {
      aggregate_id: params.raisingTaskId,
      aggregate_type: 'task',
      event_type: 'BlockerRaised',
      payload: {
        blocker_id: blockerId,
        raising_task_id: params.raisingTaskId,
        ticket_id: params.ticketId ?? null,
        question: params.question,
        context: params.context,
        requested_resolver_role: params.requestedResolverRole,
        urgency: params.urgency,
        origin_post_id: postResult.postId,
      },
      actor: params.raisingActor,
      capability_id: params.capability?.capability_id,
      trace_id: traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    const env = await this.eventStore.append(raisedEvent)

    return { blockerId, originPostId: postResult.postId, raisedEventId: env.event_id }
  }

  // -------------------------------------------------------------------------
  // routeToResolver
  // -------------------------------------------------------------------------

  async routeToResolver(blockerId: string): Promise<RouteResult | null> {
    const rows = await this.db.select().from(blockers).where(eq(blockers.blockerId, blockerId)).limit(1)
    const blocker = rows[0]
    if (!blocker) {
      throw new OrbitalError('NOT_FOUND_BLOCKER', `blocker ${blockerId} not found`)
    }

    if (
      blocker.state !== 'raised' &&
      blocker.state !== 'routed' &&
      blocker.state !== 'in_resolution'
    ) {
      throw new OrbitalError(
        'CONFLICT_INVALID_STATE_TRANSITION',
        `routeToResolver requires state in (raised, routed, in_resolution); have ${blocker.state}`,
      )
    }

    // Critical urgency short-circuits to escalation per §10.7.
    if (blocker.urgency === 'critical' && blocker.routingAttempts === 0) {
      await this.escalate({
        blockerId,
        reason: 'critical_class',
        actor: SYSTEM_ACTOR,
      })
      return null
    }

    // Compute next-in-chain candidate.
    const chain = this.resolverChain[blocker.requestedResolverRole] ?? [
      blocker.requestedResolverRole,
    ]
    const attempt = blocker.routingAttempts
    if (attempt >= blocker.maxRoutingAttempts || attempt >= chain.length) {
      await this.escalate({
        blockerId,
        reason: 'routing_exhausted',
        actor: SYSTEM_ACTOR,
      })
      return null
    }
    const candidateRole = chain[attempt]
    if (typeof candidateRole !== 'string') {
      await this.escalate({
        blockerId,
        reason: 'routing_exhausted',
        actor: SYSTEM_ACTOR,
      })
      return null
    }

    // Allocate a resolver-task id (no row inserted into tasks here; Phase 4B's
    // SprintService is responsible for tasks-table writes via the Scheduler).
    // Phase 3A emits a TaskCreated event with synthetic resolver_task_id so the
    // scheduler / hook can later pick it up.
    const resolverTaskId = uuidv7()
    const traceId = uuidv7()
    const now = new Date()

    const resolverActor: Actor = {
      type: 'system',
      component: 'orchestrator',
    }

    await this.db
      .update(blockers)
      .set({
        state: 'in_resolution',
        routedToActor: resolverActor as unknown as Record<string, unknown>,
        routedToTaskId: resolverTaskId,
        routingAttempts: attempt + 1,
      })
      .where(eq(blockers.blockerId, blockerId))

    const routedEvent: EventInput = {
      aggregate_id: blocker.raisingTaskId,
      aggregate_type: 'task',
      event_type: 'BlockerRouted',
      payload: {
        blocker_id: blockerId,
        target_persona_id: candidateRole,
        routed_to_role: candidateRole,
        routed_to_session_id: resolverTaskId,
        routing_attempt: attempt + 1,
      },
      actor: SYSTEM_ACTOR,
      trace_id: traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    const env = await this.eventStore.append(routedEvent)

    // Best-effort spawn handoff (Phase 4B refines).
    if (this.onRoute) {
      try {
        await this.onRoute({
          blockerId,
          resolverRole: candidateRole,
          resolverTaskId,
          raisingTaskId: blocker.raisingTaskId,
          ticketId: blocker.ticketId,
        })
      } catch (err) {
        logger.warn({ err, blockerId }, 'BlockerService.onRoute failed (non-fatal)')
      }
    }

    return {
      blockerId,
      routedToRole: candidateRole,
      routedToTaskId: resolverTaskId,
      routingAttempt: attempt + 1,
      routedEventId: env.event_id,
    }
  }

  // -------------------------------------------------------------------------
  // resolve
  // -------------------------------------------------------------------------

  async resolve(params: {
    blockerId: string
    resolutionPostId: string
    resolvedByRole: string
    actor: Actor
  }): Promise<void> {
    const rows = await this.db
      .select()
      .from(blockers)
      .where(eq(blockers.blockerId, params.blockerId))
      .limit(1)
    const blocker = rows[0]
    if (!blocker) throw new OrbitalError('NOT_FOUND_BLOCKER', `blocker ${params.blockerId} not found`)
    if (blocker.state === 'resolved' || blocker.state === 'abandoned') return

    await this.db
      .update(blockers)
      .set({
        state: 'resolved',
        resolutionPostId: params.resolutionPostId,
        resolvedAt: new Date(),
      })
      .where(eq(blockers.blockerId, params.blockerId))

    const ev: EventInput = {
      aggregate_id: blocker.raisingTaskId,
      aggregate_type: 'task',
      event_type: 'BlockerResolved',
      payload: {
        blocker_id: params.blockerId,
        resolution_post_id: params.resolutionPostId,
        resolved_by_role: params.resolvedByRole,
      },
      actor: params.actor,
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)
  }

  // -------------------------------------------------------------------------
  // escalate
  // -------------------------------------------------------------------------

  async escalate(params: {
    blockerId: string
    reason: 'routing_exhausted' | 'critical_class' | 'tie_breaker_failed'
    attachedAnalysis?: string
    actor?: Actor
  }): Promise<void> {
    const rows = await this.db
      .select()
      .from(blockers)
      .where(eq(blockers.blockerId, params.blockerId))
      .limit(1)
    const blocker = rows[0]
    if (!blocker) throw new OrbitalError('NOT_FOUND_BLOCKER', `blocker ${params.blockerId} not found`)
    if (blocker.state === 'escalated') return

    await this.db
      .update(blockers)
      .set({ state: 'escalated', escalatedAt: new Date() })
      .where(eq(blockers.blockerId, params.blockerId))

    // Auto-post into #escalations for user visibility.
    const escalations = await this.channels.getByName('#escalations')
    if (escalations) {
      await this.channels.post(
        escalations.channelId,
        {
          postType: 'system_event',
          payload: {
            event_kind: 'blocker_escalated',
            body: `Blocker ${params.blockerId} escalated: ${blocker.question}`,
            ...(params.attachedAnalysis ? { linked_event_id: params.attachedAnalysis } : {}),
          },
          author: params.actor ?? SYSTEM_ACTOR,
          justification: `BlockerEscalated reason=${params.reason}`,
        },
      )
    }

    const ev: EventInput = {
      aggregate_id: blocker.raisingTaskId,
      aggregate_type: 'task',
      event_type: 'BlockerEscalated',
      payload: {
        blocker_id: params.blockerId,
        reason: params.reason,
        attached_analysis: params.attachedAnalysis ?? null,
      },
      actor: params.actor ?? SYSTEM_ACTOR,
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)
  }
}

// ---------------------------------------------------------------------------
// Helper: derive the durable-channel name for a blocker (used by callers).
// ---------------------------------------------------------------------------

export function blockerDurableChannelName(ticketId: string): string {
  return canonicalChannelName('ticket_durable', ticketId)
}
