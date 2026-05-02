/**
 * trpc-start.integration.test.ts — Verifies the bug fix for Round 4:
 * `vision.start` requires the Primitives §14 audit_metadata envelope.
 *
 * The UI now sends:
 *   { title, initial_prompt, audit_metadata: { actor, justification, trace_id, ... } }
 *
 * This test exercises the real tRPC caller (createCallerFactory) so the
 * Zod input schema is enforced exactly as it would be over HTTP. It
 * verifies:
 *
 *   1. With the correct audit_metadata envelope, vision.start returns
 *      ids and a session is created.
 *   2. Without audit_metadata, the input fails validation (the bug shape).
 *   3. With a missing initial_prompt, the input fails validation.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import postgres from 'postgres'
import { drizzle } from 'drizzle-orm/postgres-js'
import { uuidv7 } from 'uuidv7'

import { t } from '../../../src/trpc/init.js'
import { appRouter } from '../../../src/trpc/routers/index.js'

const DATABASE_URL =
  process.env['DATABASE_URL'] ??
  'postgres://orbital:orbital@localhost:5432/orbital'

let pool: postgres.Sql

beforeAll(async () => {
  pool = postgres(DATABASE_URL, { max: 5, onnotice: () => {} })
  // touch drizzle to keep import live (the appRouter under test wires its own pool)
  drizzle(pool)
})

afterAll(async () => {
  await pool.end({ timeout: 5 })
})

describe('vision.start — Round 4 audit_metadata contract', () => {
  it('accepts correct {title, initial_prompt, audit_metadata} payload', async () => {
    const createCaller = t.createCallerFactory(appRouter)
    const caller = createCaller({})

    const result = await caller.vision.start({
      title: `Round 4 fix ${uuidv7().slice(0, 8)}`,
      initial_prompt: 'Build a calculator app — fix verification.',
      audit_metadata: {
        actor: { type: 'user', user_id: 'test-user', install_id: 'test-install' },
        justification: 'Round 4 contract test: correct payload shape',
        trace_id: uuidv7(),
        linked_artifacts: [],
      },
    })

    expect(result.vision_session_id).toBeTruthy()
    expect(result.vision_document_id).toBeTruthy()
    expect(result.state).toBe('open')
  })

  it('rejects payload without audit_metadata (proves the original bug shape)', async () => {
    const createCaller = t.createCallerFactory(appRouter)
    const caller = createCaller({})

    // Cast to a permissive shape because we are deliberately probing schema rejection.
    type Loose = (input: Record<string, unknown>) => Promise<unknown>
    await expect(
      (caller.vision.start as unknown as Loose)({
        title: 'Calculator',
        initialPrompt: 'Build X', // wrong field name AND missing audit_metadata
      }),
    ).rejects.toThrow()
  })

  it('rejects payload missing initial_prompt', async () => {
    const createCaller = t.createCallerFactory(appRouter)
    const caller = createCaller({})

    type Loose = (input: Record<string, unknown>) => Promise<unknown>
    await expect(
      (caller.vision.start as unknown as Loose)({
        title: 'Calculator',
        audit_metadata: {
          actor: { type: 'user', user_id: 'u', install_id: 'i' },
          justification: 'no prompt',
          trace_id: uuidv7(),
          linked_artifacts: [],
        },
      }),
    ).rejects.toThrow()
  })
})
