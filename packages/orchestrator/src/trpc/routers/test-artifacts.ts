/**
 * trpc/routers/test-artifacts.ts — QA test artifact CRUD + approval/rejection.
 *
 * [Engineer-Sr · Sonnet · run-ac-test-generation]
 *
 * Procedures:
 *   testArtifacts.list({ story_id })
 *     — list all artifacts for a story (pending/approved/merged).
 *   testArtifacts.generate({ story_id, project_id })  MUTATION
 *     — (re)generate failing tests for a story. Calls qa.generateTests.
 *   testArtifacts.approve({ artifact_id, story_branch })  MUTATION
 *     — approve + mark merged; engineer-sr can proceed.
 *   testArtifacts.reject({ artifact_id })  MUTATION
 *     — delete the artifact row so caller can re-queue generation.
 *
 * Tenant isolation: every read + write filters by ctx.tenantId. The mutations
 * assert row ownership before touching it.
 */

import { z } from 'zod'
import { TRPCError } from '@trpc/server'
import { and, desc, eq } from 'drizzle-orm'

import { router } from '../init.js'
import { tenantProcedure } from '../middleware/tenant.js'
import { db as defaultDb } from '../../db/client.js'
import { storyTestArtifacts } from '../../db/schema/story-test-artifacts.js'
import { stories } from '../../db/schema/backlog.js'
import { logger } from '../../config/logger.js'
import {
  generateTests,
  approveArtifact,
  rejectArtifact,
} from '../../qa/test-generator.js'

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const listInput = z.object({ story_id: z.string().uuid() })

const generateInput = z.object({
  story_id: z.string().uuid(),
  project_id: z.string().uuid(),
})

const approveInput = z.object({
  artifact_id: z.string().uuid(),
  /** Branch name the engineer-sr will work on — tests merge into it. */
  story_branch: z.string().min(1).max(200).default('main'),
})

const rejectInput = z.object({ artifact_id: z.string().uuid() })

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const testArtifactsRouter = router({
  /**
   * @route   testArtifacts.list({ story_id })
   * @summary Return all test artifacts for a story, newest first.
   * @access  Private (tenant)
   */
  list: tenantProcedure.input(listInput).query(async ({ ctx, input }) => {
    const db = defaultDb
    // Verify the story belongs to this tenant before returning artifacts.
    const storyRows = await db
      .select({ storyId: stories.storyId })
      .from(stories)
      .where(and(eq(stories.storyId, input.story_id), eq(stories.tenantId, ctx.tenantId!)))
      .limit(1)
    if (!storyRows[0]) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Story not found' })
    }

    const artifacts = await db
      .select()
      .from(storyTestArtifacts)
      .where(
        and(
          eq(storyTestArtifacts.storyId, input.story_id),
          eq(storyTestArtifacts.tenantId, ctx.tenantId!),
        ),
      )
      .orderBy(desc(storyTestArtifacts.generatedAt))

    return { artifacts }
  }),

  /**
   * @route   testArtifacts.generate({ story_id, project_id })  MUTATION
   * @summary Generate failing tests for a story's ACs. Real Claude call.
   * @access  Private (tenant)
   *
   * @returns { artifactId, branch, testPath, language, framework, committed, summary }
   * @returns {404} Story or project not found
   * @returns {500} Claude API failure
   */
  generate: tenantProcedure.input(generateInput).mutation(async ({ ctx, input }) => {
    const db = defaultDb

    // Verify story ownership.
    const storyRows = await db
      .select({ storyId: stories.storyId, status: stories.status })
      .from(stories)
      .where(and(eq(stories.storyId, input.story_id), eq(stories.tenantId, ctx.tenantId!)))
      .limit(1)
    if (!storyRows[0]) {
      throw new TRPCError({ code: 'NOT_FOUND', message: 'Story not found' })
    }

    try {
      const result = await generateTests(
        {
          tenantId: ctx.tenantId!,
          projectId: input.project_id,
          storyId: input.story_id,
        },
        db,
      )
      return result
    } catch (err) {
      logger.error(
        { err, tenantId: ctx.tenantId, storyId: input.story_id },
        'testArtifacts.generate: generation failed',
      )
      throw new TRPCError({
        code: 'INTERNAL_SERVER_ERROR',
        message: (err as Error).message ?? 'Test generation failed',
      })
    }
  }),

  /**
   * @route   testArtifacts.approve({ artifact_id, story_branch })  MUTATION
   * @summary Mark an artifact approved + merged; unblocks engineer-sr.
   * @access  Private (tenant)
   */
  approve: tenantProcedure.input(approveInput).mutation(async ({ ctx, input }) => {
    const db = defaultDb
    try {
      await approveArtifact(input.artifact_id, ctx.tenantId!, input.story_branch, db)
      return { ok: true as const }
    } catch (err) {
      const msg = (err as Error).message ?? 'Approval failed'
      if (msg.includes('not found')) {
        throw new TRPCError({ code: 'NOT_FOUND', message: msg })
      }
      if (msg.includes('expected pending')) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: msg })
      }
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg })
    }
  }),

  /**
   * @route   testArtifacts.reject({ artifact_id })  MUTATION
   * @summary Delete a pending artifact so it can be regenerated.
   * @access  Private (tenant)
   */
  reject: tenantProcedure.input(rejectInput).mutation(async ({ ctx, input }) => {
    const db = defaultDb
    try {
      await rejectArtifact(input.artifact_id, ctx.tenantId!, db)
      return { ok: true as const }
    } catch (err) {
      const msg = (err as Error).message ?? 'Rejection failed'
      if (msg.includes('not found')) {
        throw new TRPCError({ code: 'NOT_FOUND', message: msg })
      }
      if (msg.includes('expected pending')) {
        throw new TRPCError({ code: 'BAD_REQUEST', message: msg })
      }
      throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: msg })
    }
  }),
})

export type TestArtifactsRouter = typeof testArtifactsRouter
