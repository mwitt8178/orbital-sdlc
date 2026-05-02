/**
 * Integration tests for the PM stub round-trip in dev mode.
 *
 * Verifies the full chat round-trip produces real DB rows + real events:
 *   1. Start a vision session.
 *   2. Send 5 user messages, each triggering a deterministic PM reply via
 *      VisionPMStub.onMessage().
 *   3. After message 3, a skeleton draft version is written.
 *   4. Messages 5+ produce the wrap-up reply.
 *   5. Real VisionMessageSent events exist for both user and pm_persona sides.
 *
 * Uses real Postgres. No mocks for DB/EventStore.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { eq, and } from 'drizzle-orm'
import { PostgresEventStore } from '../../../src/events/store.js'
import { VisionPMStub } from '../../../src/vision/pm-stub.js'
import { DefaultVisionService } from '../../../src/vision/service.js'
import { DefaultChannelsService } from '../../../src/comms/channels.js'
import { HookEngine } from '../../../src/hooks/engine.js'
import {
  visionDocuments,
  visionVersions,
  visionSessions,
  visionMessages,
} from '../../../src/db/schema/vision.js'
import type { VisionSessionId } from '../../../src/vision/types.js'
import type { Actor } from '@orbital/types'

// ---------------------------------------------------------------------------
// DB setup — mirrors service.integration.test.ts bootstrap
// ---------------------------------------------------------------------------

const DATABASE_URL =
  process.env['DATABASE_URL'] ?? 'postgres://orbital:orbital@localhost:5432/orbital'

const INSTALL_ID = uuidv7()

let sqlPool: postgres.Sql
let store: PostgresEventStore
let visionService: DefaultVisionService
let pmStub: VisionPMStub

function makeStubCapabilityAuthority() {
  return {
    issue: async () => ({
      bundle: {
        capability_id: uuidv7(),
        install_id: INSTALL_ID,
        persona_id: 'pm',
        task_id: uuidv7(),
        sprint_id: 'sprint-1',
        session_id: uuidv7(),
        scopes: {
          files_read: [],
          files_write: [],
          board_read: ['*'],
          board_mutate: [],
          channel_read: [],
          channel_post: ['#vision-intake-*'],
          secrets: [],
          network_egress: ['api.anthropic.com'],
          spawn_subagent: false,
          git_commit: null,
          ceremony_role: null,
        },
        issued_at: new Date().toISOString(),
        expires_at: new Date(Date.now() + 3_600_000).toISOString(),
        signature: '',
      },
      capability_id: uuidv7(),
    }),
    verify: async () => ({ ok: true }),
    revoke: async () => {},
    hasScope: () => true,
    validateAndEmit: async () => ({ allowed: true }),
  }
}

function makeStubPersonaLoader() {
  return {
    load: async () => {},
    get: async (id: string) => ({
      personaId: id === 'pm' ? 'pm-persona-id' : id,
      slug: 'pm',
      displayName: 'Product Manager',
      origin: 'baseline' as const,
      personaVersionId: uuidv7(),
      versionNumber: 1,
      roleBriefMd: 'PM persona brief',
      definitionHash: 'hash',
      defaultCapabilityProfile: {
        filesRead: [],
        filesWrite: [],
        boardRead: ['*'],
        boardMutate: [],
        channelRead: [],
        channelPost: ['#sprint-*'],
        secrets: [],
        networkEgress: ['api.anthropic.com'],
        spawnSubagent: false,
        gitCommit: null,
        ceremonyRole: null,
      },
      modelAffinity: [
        {
          riskClass: 'standard' as const,
          preferredModel: 'claude-sonnet-4-6' as const,
          fallbackModel: null,
          maxTokensHint: null,
          rationale: 'test',
        },
      ],
      escalationPolicy: {
        maxRetries: 2,
        rules: [],
        defaultAction: 'post_blocker' as const,
      },
      skills: [],
      metadata: { tags: [], description: 'test PM' },
      isArchived: false,
    }),
    getActive: async () => [],
  }
}

function makeStubRoutingEngine() {
  return {
    selectModel: async (input: {
      task_id: string
      persona_id: string
      risk_class: string
      retry_depth?: number
    }) => ({
      decision_id: uuidv7(),
      task_id: input.task_id,
      persona_id: input.persona_id,
      risk_class: input.risk_class,
      retry_depth: input.retry_depth ?? 0,
      model: 'claude-sonnet-4-6' as const,
      token_budget: 8000,
      escalation_policy: { max_retries: 2, rules: [], default_action: 'post_blocker' },
      reason: { rules_applied: [], final_model: 'claude-sonnet-4-6' },
      policy_version: 1,
    }),
  }
}

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, { max: 5, idle_timeout: 15, onnotice: () => {} })
  const db = drizzle(sqlPool)
  store = new PostgresEventStore(db, sqlPool)
  const channelsService = new DefaultChannelsService(db, store)
  const hookEngine = new HookEngine(store, db)

  visionService = new DefaultVisionService(
    db,
    store,
    channelsService,
    hookEngine,
    makeStubPersonaLoader() as ReturnType<typeof makeStubPersonaLoader>,
    makeStubCapabilityAuthority() as ReturnType<typeof makeStubCapabilityAuthority>,
    makeStubRoutingEngine() as ReturnType<typeof makeStubRoutingEngine>,
    INSTALL_ID,
  )

  // Use 0ms delay so tests are fast — the default 1200ms would make the suite
  // very slow. Override via env variable picked up in VisionPMStub constructor.
  process.env['VISION_PM_STUB_DELAY_MS'] = '0'
  pmStub = new VisionPMStub(db, store)
})

afterAll(async () => {
  await store.stopNotifyClient()
  await sqlPool.end({ timeout: 5 })
  delete process.env['VISION_PM_STUB_DELAY_MS']
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const userActor: Actor = {
  type: 'user',
  user_id: 'stub-test-user',
  install_id: INSTALL_ID,
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('VisionPMStub — full chat round-trip (dev mode)', () => {
  it('produces real DB rows and events for 5 user+PM exchanges then a draft', async () => {
    const title = `PM Stub Test ${uuidv7().slice(0, 8)}`

    const { vision_document_id, vision_session_id } = await visionService.start({
      title,
      initial_prompt: 'We want to build a CI/CD observability dashboard.',
      install_id: INSTALL_ID,
      actor: userActor,
      trace_id: uuidv7(),
      justification: 'PM stub integration test',
    })

    const sessionId = vision_session_id as VisionSessionId
    const db = drizzle(sqlPool)

    // --- Send 5 user messages, each followed by a PM stub reply ---
    const userMessages = [
      'Our primary users are platform engineers.',
      'MVP should show deployment frequency and failure rate.',
      'Must handle 500 deploys/day; SOC2 compliant; no PII in logs.',
      "Success metric: 80% of engineers use it daily within 2 weeks of launch.",
      'That covers everything I had in mind.',
    ]

    for (let i = 0; i < userMessages.length; i++) {
      const userMsg = await visionService.sendMessage(
        sessionId,
        userMessages[i]!,
        userActor,
        uuidv7(),
      )
      expect(userMsg.author_type).toBe('user')

      // Invoke the stub directly (simulating what the subscriber does after
      // the VisionMessageSent event fires).
      const userCount = i + 1
      await pmStub.onMessage(sessionId, userCount)
    }

    // Verify vision_messages rows: 5 user + 5 PM = 10
    const allMessages = await db
      .select()
      .from(visionMessages)
      .where(eq(visionMessages.visionSessionId, sessionId))

    const userMsgRows = allMessages.filter((m) => m.authorType === 'user')
    const pmMsgRows = allMessages.filter((m) => m.authorType === 'pm_persona')

    expect(userMsgRows).toHaveLength(5)
    expect(pmMsgRows).toHaveLength(5)

    // Verify PM replies contain expected script lines
    const pmBodies = pmMsgRows.map((m) => m.body)
    expect(pmBodies[0]).toContain('Who is the primary user')
    expect(pmBodies[1]).toContain('smallest version')
    expect(pmBodies[2]).toContain('non-functional constraints')
    expect(pmBodies[3]).toContain('success metric')
    expect(pmBodies[4]).toContain("I think I have enough to draft")

    // Verify VisionMessageSent events: 5 user + 5 PM = 10
    const msgEvents = await store.query({
      aggregate_type: 'vision_document',
      aggregate_id: vision_document_id,
      event_type: 'VisionMessageSent',
    })
    expect(msgEvents.items.length).toBeGreaterThanOrEqual(10)

    const pmEvents = msgEvents.items.filter(
      (e) => (e.payload as Record<string, unknown>)['author_type'] === 'pm_persona',
    )
    expect(pmEvents.length).toBeGreaterThanOrEqual(5)

    // Verify a draft version was written after message 3
    const draftVersionRows = await db
      .select()
      .from(visionVersions)
      .where(
        and(
          eq(visionVersions.visionDocumentId, vision_document_id),
          eq(visionVersions.isLocked, 0),
        ),
      )
    expect(draftVersionRows.length).toBeGreaterThanOrEqual(1)

    const draftContent = draftVersionRows[0]?.content as Record<string, unknown>
    expect(draftContent).toBeTruthy()
    expect(draftContent?.['title']).toBe(title)
    expect(Array.isArray(draftContent?.['goals'])).toBe(true)

    // Verify VisionDrafted event exists
    const draftEvents = await store.query({
      aggregate_type: 'vision_document',
      aggregate_id: vision_document_id,
      event_type: 'VisionDrafted',
    })
    expect(draftEvents.items.length).toBeGreaterThanOrEqual(1)

    // Verify the document pointer was updated
    const docRows = await db
      .select()
      .from(visionDocuments)
      .where(eq(visionDocuments.visionDocumentId, vision_document_id))
      .limit(1)
    expect(docRows[0]?.currentVersionId).not.toBeNull()
  })

  it('does not duplicate drafts on additional messages past 3', async () => {
    const title = `Draft Dedup Test ${uuidv7().slice(0, 8)}`
    const db = drizzle(sqlPool)

    const { vision_document_id, vision_session_id } = await visionService.start({
      title,
      initial_prompt: 'Testing draft deduplication.',
      install_id: INSTALL_ID,
      actor: userActor,
      trace_id: uuidv7(),
      justification: 'PM stub draft dedup test',
    })

    const sessionId = vision_session_id as VisionSessionId

    // Send 5 messages — stub fires after each, but draft should only be created once
    for (let i = 1; i <= 5; i++) {
      await visionService.sendMessage(sessionId, `Message ${i}`, userActor, uuidv7())
      await pmStub.onMessage(sessionId, i)
    }

    const draftRows = await db
      .select()
      .from(visionVersions)
      .where(
        and(
          eq(visionVersions.visionDocumentId, vision_document_id),
          eq(visionVersions.isLocked, 0),
        ),
      )

    // Draft is written once after message 3. Subsequent calls are idempotent.
    expect(draftRows.length).toBe(1)
  })

  it('skips reply when session is no longer open', async () => {
    const title = `Closed Session Test ${uuidv7().slice(0, 8)}`
    const db = drizzle(sqlPool)

    const { vision_document_id, vision_session_id } = await visionService.start({
      title,
      initial_prompt: 'Testing closed session guard.',
      install_id: INSTALL_ID,
      actor: userActor,
      trace_id: uuidv7(),
      justification: 'PM stub closed session guard test',
    })

    const sessionId = vision_session_id as VisionSessionId

    // Manually close the session
    await db
      .update(visionSessions)
      .set({ state: 'closed_locked' })
      .where(eq(visionSessions.visionSessionId, sessionId))

    // Stub should not throw and should not write any PM messages
    await pmStub.onMessage(sessionId, 1)

    const pmRows = await db
      .select()
      .from(visionMessages)
      .where(
        and(
          eq(visionMessages.visionSessionId, sessionId),
          eq(visionMessages.authorType, 'pm_persona'),
        ),
      )

    expect(pmRows).toHaveLength(0)
    void vision_document_id // used to avoid unused-var lint
  })
})
