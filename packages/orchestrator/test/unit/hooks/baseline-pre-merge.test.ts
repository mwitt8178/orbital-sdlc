/**
 * baseline-pre-merge.test.ts — Unit tests for the pre-merge hook.
 *
 * Per task spec and TRD-09 §8:
 * - pre-merge hook blocks AgentMergedBranch when unresolved conflicts exist
 * - uses conflict_files array in payload to avoid shelling out to git in unit tests
 * - allows merge when no conflicts
 * - error code: HOOK_REJECTED_PRE_MERGE
 */

import { describe, it, expect } from 'vitest'
import { uuidv7 } from 'uuidv7'
import type { HookContext } from '../../../src/hooks/types.js'
import preMergeHook from '../../../src/hooks/baseline/pre-merge.js'

function ctx(): HookContext {
  return {
    trace_id: uuidv7(),
    actor: { type: 'system', component: 'orchestrator' },
  }
}

describe('pre-merge baseline hook', () => {
  describe('hook spec', () => {
    it('has correct slug', () => {
      expect(preMergeHook.slug).toBe('pre-merge-no-unresolved-conflicts')
    })

    it('applies to AgentMergedBranch', () => {
      expect(preMergeHook.appliesTo).toContain('AgentMergedBranch')
    })

    it('has timing pre', () => {
      expect(preMergeHook.timing).toBe('pre')
    })

    it('has correct errorCode', () => {
      expect(preMergeHook.errorCode).toBe('HOOK_REJECTED_PRE_MERGE')
    })

    it('has declaredOrder 50', () => {
      expect(preMergeHook.declaredOrder).toBe(50)
    })
  })

  describe('validator — conflict_files path (no git subprocess)', () => {
    it('allows merge when conflict_files is empty', async () => {
      const result = await preMergeHook.validator(
        { conflict_files: [] },
        ctx(),
      )
      expect(result.allow).toBe(true)
    })

    it('blocks merge when conflict_files has entries', async () => {
      const result = await preMergeHook.validator(
        {
          conflict_files: ['src/billing/webhooks.ts'],
          branch: 'feat/billing',
        },
        ctx(),
      )
      expect(result.allow).toBe(false)
    })

    it('blocks merge with multiple conflict files', async () => {
      const result = await preMergeHook.validator(
        {
          conflict_files: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        },
        ctx(),
      )
      expect(result.allow).toBe(false)
      if (!result.allow) {
        expect(result.reason).toContain('src/a.ts')
        expect(result.reason).toContain('src/b.ts')
        expect(result.reason).toContain('src/c.ts')
      }
    })

    it('includes "merge rejected" in rejection reason', async () => {
      const result = await preMergeHook.validator(
        { conflict_files: ['src/billing/webhooks.ts'] },
        ctx(),
      )
      expect(result.allow).toBe(false)
      if (!result.allow) {
        expect(result.reason).toMatch(/merge rejected/i)
      }
    })
  })

  describe('validator — no worktree path (permissive fallback)', () => {
    it('allows when neither conflict_files nor worktree_path is provided', async () => {
      const result = await preMergeHook.validator({}, ctx())
      expect(result.allow).toBe(true)
    })

    it('allows when only task_id and branch provided (no path, no conflicts)', async () => {
      const result = await preMergeHook.validator(
        { task_id: uuidv7(), branch: 'feat/test' },
        ctx(),
      )
      expect(result.allow).toBe(true)
    })
  })

  describe('validator — malformed payload (parse failure is permissive)', () => {
    it('allows on completely invalid payload type', async () => {
      // Non-object input — PayloadSchema.safeParse fails, hook passes through
      const result = await preMergeHook.validator(null as unknown as Record<string, unknown>, ctx())
      expect(result.allow).toBe(true)
    })
  })
})
