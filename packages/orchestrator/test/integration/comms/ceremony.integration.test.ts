/**
 * Integration test: CeremonyService end-to-end.
 *
 * Exercises:
 *   - schedule: writes spec + ceremony + channel, emits CeremonyScheduled
 *   - addParticipant + start: emits CeremonyStarted
 *   - recordTurn: 3 participants × 3 turns each within budget
 *   - 4th turn attempt rejected with CONFLICT_TURN_BUDGET_EXCEEDED
 *   - vote + close + writeOutput
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { PostgresEventStore } from '../../../src/events/store.js'
import { DefaultChannelsService } from '../../../src/comms/channels.js'
import {
  DefaultCeremonyService,
  seedBaselineCeremonySpecs,
} from '../../../src/comms/ceremonies.js'
import type { Actor } from '@orbital/types'

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://orbital:orbital@localhost:5432/orbital'

let sqlPool: postgres.Sql
let store: PostgresEventStore
let channels: DefaultChannelsService
let ceremonyService: DefaultCeremonyService
let db: ReturnType<typeof drizzle>

beforeAll(async () => {
  sqlPool = postgres(DATABASE_URL, { max: 10, idle_timeout: 15, onnotice: () => {} })
  db = drizzle(sqlPool)
  store = new PostgresEventStore(db, sqlPool)
  channels = new DefaultChannelsService(db, store)
  await channels.bootstrapBaseline()
  await seedBaselineCeremonySpecs(db)
  ceremonyService = new DefaultCeremonyService(db, store, channels)
})

afterAll(async () => {
  await store.stopNotifyClient()
  await sqlPool.end({ timeout: 5 })
})

const triggerActor: Actor = { type: 'system', component: 'orchestrator' }

function personaActor(personaId: string, sessionId: string): Actor {
  return { type: 'persona', persona_id: personaId, session_id: sessionId }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('CeremonyService — happy path: 3 participants × 3 turns + vote + output', () => {
  it('runs through the full lifecycle and rejects the 4th turn', async () => {
    const ticketId = `ORB-${uuidv7().slice(0, 8)}`

    // Schedule with the 'ad_hoc' baseline (no vote required) to keep this test focused
    // on the turn budget. Override turns_per_participant to 3 for clarity.
    const sched = await ceremonyService.schedule({
      ceremonyType: 'architecture_review',
      scope: { ticket_id: ticketId },
      triggeredBy: triggerActor,
      turnsPerParticipant: 3,
      tokensPerTurn: 2000,
      wallClockBudgetMs: 30 * 60 * 1000,
    })
    expect(sched.ceremonyId).toBeTypeOf('string')
    expect(sched.channelId).toBeTypeOf('string')

    // CeremonyScheduled event should be present.
    const schedEvents = await store.query({
      aggregate_id: sched.ceremonyId,
      event_type: 'CeremonyScheduled',
      limit: 5,
    })
    expect(schedEvents.items).toHaveLength(1)

    // Add chair + 3 participants.
    const chair = await ceremonyService.addParticipant({
      ceremonyId: sched.ceremonyId,
      personaRole: 'architect',
      personaId: 'p-architect',
      sessionId: `sess-${uuidv7()}`,
      ceremonyRole: 'chair',
    })
    const p1 = await ceremonyService.addParticipant({
      ceremonyId: sched.ceremonyId,
      personaRole: 'principal_engineer',
      personaId: 'p-pe',
      sessionId: `sess-${uuidv7()}`,
      ceremonyRole: 'participant',
    })
    const p2 = await ceremonyService.addParticipant({
      ceremonyId: sched.ceremonyId,
      personaRole: 'security_officer',
      personaId: 'p-so',
      sessionId: `sess-${uuidv7()}`,
      ceremonyRole: 'participant',
    })

    // Post agenda (use ChannelsService directly for the agenda — chair posts ceremony_agenda).
    const agendaResult = await channels.post(
      sched.channelId as never,
      {
        postType: 'ceremony_agenda',
        payload: {
          body: 'Reviewing module boundary',
          open_questions: ['where to draw'],
          proposals: ['option A', 'option B'],
        },
        author: personaActor('p-architect', 'sess'),
        ceremonyId: sched.ceremonyId,
        justification: 'agenda',
      },
    )

    await ceremonyService.start(sched.ceremonyId, agendaResult.postId)

    const startEvents = await store.query({
      aggregate_id: sched.ceremonyId,
      event_type: 'CeremonyStarted',
      limit: 5,
    })
    expect(startEvents.items).toHaveLength(1)

    // 3 participants × 3 turns each = 9 valid turns.
    for (let i = 0; i < 3; i++) {
      const r1 = await ceremonyService.recordTurn({
        ceremonyId: sched.ceremonyId,
        participantId: p1.participantId,
        body: `Turn ${i + 1} from PE`,
      })
      expect(r1.turnNumber).toBeGreaterThanOrEqual(1)
      const r2 = await ceremonyService.recordTurn({
        ceremonyId: sched.ceremonyId,
        participantId: p2.participantId,
        body: `Turn ${i + 1} from SO`,
      })
      expect(r2.turnNumber).toBeGreaterThanOrEqual(1)
      // Chair also gets turns (chair is also a participant for statements).
      const rc = await ceremonyService.recordTurn({
        ceremonyId: sched.ceremonyId,
        participantId: chair.participantId,
        body: `Turn ${i + 1} from chair`,
      })
      expect(rc.turnNumber).toBeGreaterThanOrEqual(1)
    }

    // 4th turn from any participant must be rejected.
    await expect(
      ceremonyService.recordTurn({
        ceremonyId: sched.ceremonyId,
        participantId: p1.participantId,
        body: 'Turn 4 — should fail',
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT_TURN_BUDGET_EXCEEDED' })

    // Token-budget enforcement: a turn over the per-turn cap rejects.
    // We use a fresh participant to avoid being blocked by the turn cap above.
    const fresh = await ceremonyService.addParticipant({
      ceremonyId: sched.ceremonyId,
      personaRole: 'extra',
      personaId: 'p-extra',
      sessionId: `sess-${uuidv7()}`,
      ceremonyRole: 'participant',
    })
    const longBody = 'x'.repeat(20_000) // ~5000 tokens > 2000 cap
    await expect(
      ceremonyService.recordTurn({
        ceremonyId: sched.ceremonyId,
        participantId: fresh.participantId,
        body: longBody,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_TURN_TOKENS_EXCEEDED' })

    // Drive to vote → output. Mark the 'extra' participant as yielded so the
    // quorum policy (all non-yielded participants must vote) only counts p1 + p2.
    await sqlPool`UPDATE ceremony_participants SET yielded_at = now() WHERE participant_id = ${fresh.participantId}`

    await ceremonyService.callClosure({
      ceremonyId: sched.ceremonyId,
      closureMode: 'vote',
      actor: personaActor('p-architect', chair.participantId),
      justification: 'time to vote',
    })
    await ceremonyService.castVote({
      ceremonyId: sched.ceremonyId,
      participantId: p1.participantId,
      vote: 'approve',
      justification: 'vote',
    })
    const tally = await ceremonyService.castVote({
      ceremonyId: sched.ceremonyId,
      participantId: p2.participantId,
      vote: 'approve',
      justification: 'vote',
    })
    expect(tally.tally.approve).toBeGreaterThanOrEqual(2)
    expect(tally.isQuorumReached).toBe(true)

    // After quorum reached, the orchestrator (in production) transitions
    // ceremonies.state from 'voting' to 'output_writing'. For this test we
    // simulate that transition explicitly.
    await sqlPool`UPDATE ceremonies SET state = 'output_writing' WHERE ceremony_id = ${sched.ceremonyId}`

    const out = await ceremonyService.writeOutput({
      ceremonyId: sched.ceremonyId,
      outputKind: 'adr',
      payload: { summary: 'Decided on option A' },
      authoredByActor: personaActor('p-architect', chair.participantId),
      capabilityId: uuidv7(),
      justification: 'chair writes output',
    })
    expect(out.outputId).toBeTypeOf('string')

    await ceremonyService.close(sched.ceremonyId, {
      closureMode: 'vote_passed',
      outputId: out.outputId,
      actor: triggerActor,
    })

    const closedEvents = await store.query({
      aggregate_id: sched.ceremonyId,
      event_type: 'CeremonyClosed',
      limit: 5,
    })
    expect(closedEvents.items).toHaveLength(1)
  })
})
