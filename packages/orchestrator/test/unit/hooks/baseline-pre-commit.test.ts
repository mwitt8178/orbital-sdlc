/**
 * baseline-pre-commit.test.ts — Unit tests for the pre-commit baseline hook.
 *
 * Per TRD-09 §8.1:
 * - commit_message must match /(^|\s)(ORB-\d+)(\s|$)/m
 * - The matched ticket ref must equal payload.ticket_id
 * - payload.files must all be within the actor's files_write scope (from context.capability_id)
 *
 * Per the task spec, the hook checks "file paths in commit are within bundle.scopes.files_write".
 * For v1, context carries the files_write patterns from the capability bundle;
 * they are passed in context.actor (for persona actors, the capability is looked up
 * at engine.fire time if a capability_id is provided — but the baseline hook spec
 * validates against files passed in the payload against the scope provided in context).
 *
 * For simplicity in v1: pre-commit hook validates:
 * 1. commit_message contains the ticket ref (ORB-NNN) matching payload.ticket_id
 * 2. All file paths in payload.files_changed are within payload.files_write_scope globs
 */

import { describe, it, expect } from 'vitest'
import { uuidv7 } from 'uuidv7'
import preCommitHook from '../../../src/hooks/baseline/pre-commit.js'
import type { HookContext } from '../../../src/hooks/types.js'

function ctx(): HookContext {
  return {
    trace_id: uuidv7(),
    actor: { type: 'system', component: 'orchestrator' },
  }
}

describe('pre-commit baseline hook', () => {
  describe('hook spec', () => {
    it('has correct slug', () => {
      expect(preCommitHook.slug).toBe('commit-must-have-ticket-ref')
    })

    it('applies to AgentCommitted', () => {
      expect(preCommitHook.appliesTo).toContain('AgentCommitted')
    })

    it('has timing pre', () => {
      expect(preCommitHook.timing).toBe('pre')
    })

    it('has errorCode HOOK_REJECTED_PRE_COMMIT', () => {
      expect(preCommitHook.errorCode).toBe('HOOK_REJECTED_PRE_COMMIT')
    })
  })

  describe('validator — ticket ref checks', () => {
    it('allows commit with correct ticket ref in message', async () => {
      const payload = {
        commit_message: 'ORB-237: implement webhook handler',
        ticket_id: 'ORB-237',
        files_changed: ['src/billing/webhooks.ts'],
        files_write_scope: ['src/billing/**'],
      }
      const result = await preCommitHook.validator(payload, ctx())
      expect(result.allow).toBe(true)
    })

    it('allows commit with ticket ref in multiline message', async () => {
      const payload = {
        commit_message: 'implement webhook handler\n\nCloses ORB-237 per spec',
        ticket_id: 'ORB-237',
        files_changed: ['src/billing/webhooks.ts'],
        files_write_scope: ['src/billing/**'],
      }
      const result = await preCommitHook.validator(payload, ctx())
      expect(result.allow).toBe(true)
    })

    it('rejects commit with no ticket ref', async () => {
      const payload = {
        commit_message: 'implement webhook handler without ticket',
        ticket_id: 'ORB-237',
        files_changed: ['src/billing/webhooks.ts'],
        files_write_scope: ['src/billing/**'],
      }
      const result = await preCommitHook.validator(payload, ctx())
      expect(result.allow).toBe(false)
      if (!result.allow) {
        expect(result.reason).toContain('ORB-237')
      }
    })

    it('rejects commit with wrong ticket ref (mismatched ticket_id)', async () => {
      const payload = {
        commit_message: 'ORB-999: wrong ticket',
        ticket_id: 'ORB-237',
        files_changed: ['src/billing/webhooks.ts'],
        files_write_scope: ['src/billing/**'],
      }
      const result = await preCommitHook.validator(payload, ctx())
      expect(result.allow).toBe(false)
      if (!result.allow) {
        expect(result.reason).toContain('ORB-999')
        expect(result.reason).toContain('ORB-237')
      }
    })

    it('rejects commit with empty message', async () => {
      const payload = {
        commit_message: '',
        ticket_id: 'ORB-237',
        files_changed: [],
        files_write_scope: ['src/**'],
      }
      const result = await preCommitHook.validator(payload, ctx())
      expect(result.allow).toBe(false)
    })

    it('rejects commit with empty ticket_id', async () => {
      const payload = {
        commit_message: 'ORB-237: some work',
        ticket_id: '',
        files_changed: [],
        files_write_scope: ['src/**'],
      }
      const result = await preCommitHook.validator(payload, ctx())
      expect(result.allow).toBe(false)
    })
  })

  describe('validator — files_write_scope checks', () => {
    it('rejects commit touching file outside files_write_scope', async () => {
      const payload = {
        commit_message: 'ORB-237: implement webhook',
        ticket_id: 'ORB-237',
        files_changed: ['src/billing/webhooks.ts', 'src/secrets/keys.ts'],
        files_write_scope: ['src/billing/**'],
      }
      const result = await preCommitHook.validator(payload, ctx())
      expect(result.allow).toBe(false)
      if (!result.allow) {
        expect(result.reason).toContain('src/secrets/keys.ts')
      }
    })

    it('allows commit with all files within scope', async () => {
      const payload = {
        commit_message: 'ORB-237: implement billing features',
        ticket_id: 'ORB-237',
        files_changed: ['src/billing/service.ts', 'src/billing/types.ts'],
        files_write_scope: ['src/billing/**'],
      }
      const result = await preCommitHook.validator(payload, ctx())
      expect(result.allow).toBe(true)
    })

    it('allows commit with multiple scope patterns', async () => {
      const payload = {
        commit_message: 'ORB-237: implement billing features',
        ticket_id: 'ORB-237',
        files_changed: ['src/billing/service.ts', 'test/billing/service.test.ts'],
        files_write_scope: ['src/billing/**', 'test/billing/**'],
      }
      const result = await preCommitHook.validator(payload, ctx())
      expect(result.allow).toBe(true)
    })

    it('allows commit with empty files_changed', async () => {
      const payload = {
        commit_message: 'ORB-237: empty commit',
        ticket_id: 'ORB-237',
        files_changed: [],
        files_write_scope: ['src/billing/**'],
      }
      const result = await preCommitHook.validator(payload, ctx())
      expect(result.allow).toBe(true)
    })

    it('rejects commit with wildcard files_write_scope that still misses secret file', async () => {
      const payload = {
        commit_message: 'ORB-237: update billing',
        ticket_id: 'ORB-237',
        files_changed: ['src/billing/service.ts', 'secrets/prod.key'],
        files_write_scope: ['src/**'],
      }
      const result = await preCommitHook.validator(payload, ctx())
      expect(result.allow).toBe(false)
      if (!result.allow) {
        expect(result.reason).toContain('secrets/prod.key')
      }
    })
  })
})
