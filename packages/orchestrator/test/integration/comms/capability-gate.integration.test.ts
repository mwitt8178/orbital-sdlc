/**
 * Integration test: capability-gate — jr-dev cannot post to #sprint-X.
 *
 * Round 6 #9 — Inter-Agent Channel Collaboration
 * [Engineer-Sr · Sonnet · run-round6-09-channel-collab]
 *
 * Verifies that the capability gateway rejects a jr-dev attempting to post
 * to a #sprint-* channel (not in its channelPost allowlist) with AUTH_SCOPE_DENIED.
 *
 * Also verifies that:
 *   - jr-dev CAN post to #orb-engineering (in allowlist)
 *   - sr-dev CAN post to #sprint-* (in allowlist)
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { gatewayValidateChannel } from '../../../src/capabilities/gateway.js'
import { definition as jrDevDef } from '../../../src/personas/library/jr-dev.js'
import { definition as srDevDef } from '../../../src/personas/library/sr-dev.js'
import type { CapabilityBundle } from '@orbital/types'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal CapabilityBundle from a persona's defaultCapabilityProfile.
 * The gateway's validateToolCall checks scopes from the bundle object.
 */
function makeBundleFromPersona(
  personaDef: typeof jrDevDef,
  workerId = uuidv7(),
): CapabilityBundle {
  const profile = personaDef.defaultCapabilityProfile
  return {
    capability_id: uuidv7(),
    persona_id: personaDef.slug,
    session_id: workerId,
    task_id: uuidv7(),
    worker_id: workerId,
    issued_at: new Date().toISOString(),
    expires_at: new Date(Date.now() + 3_600_000).toISOString(),
    scopes: {
      files_read: (profile.filesRead as string[]) ?? [],
      files_write: (profile.filesWrite as string[]) ?? [],
      board_read: (profile.boardRead as string[]) ?? [],
      board_mutate: (profile.boardMutate as string[]) ?? [],
      channel_read: (profile.channelRead as string[]) ?? [],
      channel_post: (profile.channelPost as string[]) ?? [],
      secrets: (profile.secrets as string[]) ?? [],
      network_egress: (profile.networkEgress as string[]) ?? [],
      spawn_subagent: profile.spawnSubagent === true,
      git_commit: profile.gitCommit
        ? [
            {
              branch: (profile.gitCommit as { branchPattern: string }).branchPattern,
              paths: [(profile.gitCommit as { pathGlob: string }).pathGlob],
            },
          ]
        : [],
      ceremony_role: (profile.ceremonyRole as string) ?? 'observer',
    },
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('capability-gate: channel post scope enforcement', () => {
  it('jr-dev is DENIED posting to #sprint-X (not in channelPost allowlist)', () => {
    const bundle = makeBundleFromPersona(jrDevDef)
    const allowed = gatewayValidateChannel(bundle, 'channel_post', '#sprint-abc123')
    expect(allowed).toBe(false)
  })

  it('jr-dev is ALLOWED posting to #orb-engineering (in channelPost allowlist)', () => {
    const bundle = makeBundleFromPersona(jrDevDef)
    const allowed = gatewayValidateChannel(bundle, 'channel_post', '#orb-engineering')
    expect(allowed).toBe(true)
  })

  it('jr-dev is ALLOWED reading from #sprint-X (in channelRead allowlist)', () => {
    const bundle = makeBundleFromPersona(jrDevDef)
    const allowed = gatewayValidateChannel(bundle, 'channel_read', '#sprint-abc123')
    expect(allowed).toBe(true)
  })

  it('jr-dev is DENIED posting to #escalation-* (not in allowlist)', () => {
    const bundle = makeBundleFromPersona(jrDevDef)
    const allowed = gatewayValidateChannel(bundle, 'channel_post', '#escalation-sprint-abc')
    expect(allowed).toBe(false)
  })

  it('sr-dev is ALLOWED posting to #sprint-X (in channelPost allowlist)', () => {
    const bundle = makeBundleFromPersona(srDevDef)
    const allowed = gatewayValidateChannel(bundle, 'channel_post', '#sprint-abc123')
    expect(allowed).toBe(true)
  })

  it('sr-dev is ALLOWED posting to #escalation-* (in channelPost allowlist)', () => {
    const bundle = makeBundleFromPersona(srDevDef)
    const allowed = gatewayValidateChannel(bundle, 'channel_post', '#escalation-sprint-def')
    expect(allowed).toBe(true)
  })

  it('sr-dev is ALLOWED posting to #review-* (in channelPost allowlist)', () => {
    const bundle = makeBundleFromPersona(srDevDef)
    const allowed = gatewayValidateChannel(bundle, 'channel_post', '#review-pr-123')
    expect(allowed).toBe(true)
  })

  it('jr-dev channelPost allowlist is restricted to #orb-* only', () => {
    const profile = jrDevDef.defaultCapabilityProfile
    // channelPost should only contain #orb-engineering (or #orb-* pattern)
    const postGlobs = profile.channelPost as string[]
    expect(postGlobs.every((g: string) => g.startsWith('#orb-'))).toBe(true)
    // Must NOT include #sprint-*, #escalation-*, #review-*
    expect(postGlobs.some((g: string) => g.startsWith('#sprint-'))).toBe(false)
    expect(postGlobs.some((g: string) => g.startsWith('#escalation-'))).toBe(false)
    expect(postGlobs.some((g: string) => g.startsWith('#review-'))).toBe(false)
  })
})
