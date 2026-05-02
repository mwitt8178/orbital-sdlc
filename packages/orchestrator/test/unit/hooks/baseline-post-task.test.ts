/**
 * baseline-post-task.test.ts — Unit tests for the post-task hook.
 *
 * Per task spec and TRD-09 §8:
 * - post-task hook triggers VerifierService.spawnVerifier on task completion
 * - hook is post-timing, applies to TaskCompleted
 * - validator always allows (post hooks are for side effects, not gating)
 * - spawnVerifier is called with taskId and artifactPaths from payload
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { uuidv7 } from 'uuidv7'
import type { HookContext } from '../../../src/hooks/types.js'
import type { VerifierService } from '../../../src/verifiers/service.js'
import { createPostTaskHook } from '../../../src/hooks/baseline/post-task.js'

function ctx(): HookContext {
  return {
    trace_id: uuidv7(),
    actor: { type: 'system', component: 'orchestrator' },
  }
}

describe('post-task baseline hook', () => {
  let mockVerifierService: VerifierService
  let hook: ReturnType<typeof createPostTaskHook>

  beforeEach(() => {
    mockVerifierService = {
      spawnVerifier: vi.fn().mockResolvedValue('verification-id-123'),
      getResult: vi.fn(),
      submitResult: vi.fn(),
    } as unknown as VerifierService

    hook = createPostTaskHook(mockVerifierService)
  })

  describe('hook spec', () => {
    it('has correct slug', () => {
      expect(hook.slug).toBe('post-task-trigger-verifier')
    })

    it('applies to TaskCompleted', () => {
      expect(hook.appliesTo).toContain('TaskCompleted')
    })

    it('has timing post', () => {
      expect(hook.timing).toBe('post')
    })

    it('has correct errorCode', () => {
      expect(hook.errorCode).toBe('HOOK_REJECTED_GENERIC')
    })
  })

  describe('validator', () => {
    it('allows the event (post hooks do not gate)', async () => {
      const taskId = uuidv7()
      const payload = {
        task_id: taskId,
        ready_for_verification: true,
        artifact_paths: ['src/billing/webhooks.ts'],
        summary: 'task completed',
      }
      const result = await hook.validator(payload, ctx())
      expect(result.allow).toBe(true)
    })

    it('calls spawnVerifier when ready_for_verification is true', async () => {
      const taskId = uuidv7()
      const artifactPaths = ['src/billing/webhooks.ts', 'src/billing/types.ts']
      const payload = {
        task_id: taskId,
        ready_for_verification: true,
        artifact_paths: artifactPaths,
        summary: 'task completed',
      }
      await hook.validator(payload, ctx())
      expect(mockVerifierService.spawnVerifier).toHaveBeenCalledWith(
        taskId,
        expect.any(String), // ticketId (derived from taskId if not set)
        artifactPaths,
        'orchestrator', // actingPersonaId
      )
    })

    it('does not call spawnVerifier when ready_for_verification is false', async () => {
      const taskId = uuidv7()
      const payload = {
        task_id: taskId,
        ready_for_verification: false,
        artifact_paths: ['src/billing/webhooks.ts'],
        summary: 'task completed without verification',
      }
      await hook.validator(payload, ctx())
      expect(mockVerifierService.spawnVerifier).not.toHaveBeenCalled()
    })

    it('does not call spawnVerifier when ready_for_verification is absent', async () => {
      const taskId = uuidv7()
      const payload = {
        task_id: taskId,
        artifact_paths: [],
        summary: 'task completed',
      }
      await hook.validator(payload, ctx())
      expect(mockVerifierService.spawnVerifier).not.toHaveBeenCalled()
    })

    it('still allows even if spawnVerifier throws (post-hook does not gate)', async () => {
      ;(mockVerifierService.spawnVerifier as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error('verifier spawn failed'),
      )
      const taskId = uuidv7()
      const payload = {
        task_id: taskId,
        ready_for_verification: true,
        artifact_paths: ['src/billing/webhooks.ts'],
        summary: 'task completed',
      }
      const result = await hook.validator(payload, ctx())
      // Post hooks should not fail the action even if side-effect fails
      expect(result.allow).toBe(true)
    })
  })
})
