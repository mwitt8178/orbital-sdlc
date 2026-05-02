/**
 * gateway.test.ts — validateToolCall scope matching and hard-deny rules.
 *
 * Pure-function tests; no DB, no crypto.
 */

import { describe, it, expect } from 'vitest'
import { uuidv7 } from 'uuidv7'
import { validateToolCall, PATH_HARD_DENY } from '../../../src/capabilities/gateway.js'
import type { CapabilityBundle, Scopes } from '@orbital/types'

function bundle(scopes: Partial<Scopes>, personaId = 'senior-developer'): CapabilityBundle {
  const fullScopes: Scopes = {
    files_read: [],
    files_write: [],
    board_read: [],
    board_mutate: [],
    channel_read: [],
    channel_post: [],
    secrets: [],
    network_egress: [],
    spawn_subagent: false,
    git_commit: [],
    ceremony_role: [],
    ...scopes,
  }
  const now = new Date()
  return {
    capability_id: uuidv7(),
    install_id: uuidv7(),
    sprint_id: uuidv7(),
    task_id: uuidv7(),
    persona_id: personaId,
    session_id: uuidv7(),
    scopes: fullScopes,
    issued_at: now.toISOString(),
    expires_at: new Date(now.getTime() + 60_000).toISOString(),
    signing_key_id: uuidv7(),
    signature: 'AAAA',
    schema_version: 1,
  }
}

describe('validateToolCall — files', () => {
  it('allows files.read on a granted glob', () => {
    const b = bundle({ files_read: ['src/billing/**'] })
    const r = validateToolCall(b, 'files.read', { path: 'src/billing/invoice.ts' })
    expect(r.allowed).toBe(true)
  })

  it('denies files.read outside granted scope', () => {
    const b = bundle({ files_read: ['src/billing/**'] })
    const r = validateToolCall(b, 'files.read', { path: 'src/admin/users.ts' })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason_code).toBe('AUTH_SCOPE_DENIED')
  })

  it('denies any write to a hard-deny path even if granted', () => {
    const b = bundle({ files_write: ['**/*'] })
    const r = validateToolCall(b, 'files.write', { path: '.env' })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason_code).toBe('AUTH_SCOPE_DENIED')
  })

  it('denies absolute paths', () => {
    const b = bundle({ files_write: ['**/*'] })
    const r = validateToolCall(b, 'files.write', { path: '/etc/passwd' })
    expect(r.allowed).toBe(false)
  })

  it('denies path traversal', () => {
    const b = bundle({ files_write: ['**/*'] })
    const r = validateToolCall(b, 'files.write', { path: '../../etc/passwd' })
    expect(r.allowed).toBe(false)
  })

  it('rejects PEM/key/secret writes via PATH_HARD_DENY', () => {
    const b = bundle({ files_write: ['**/*'] })
    for (const pathTry of [
      'config/cert.pem',
      'private.key',
      'src/secrets/api.json',
      '.env.production',
      'sub/.aws/credentials',
      'sub/.ssh/id_rsa',
    ]) {
      const r = validateToolCall(b, 'files.write', { path: pathTry })
      expect(r.allowed, `path=${pathTry}`).toBe(false)
    }
  })

  it('PATH_HARD_DENY is exported and matches expected patterns', () => {
    expect(PATH_HARD_DENY).toContain('**/secrets/**')
    expect(PATH_HARD_DENY).toContain('**/*.pem')
  })
})

describe('validateToolCall — secrets', () => {
  it('matches an exact secret key', () => {
    const b = bundle({ secrets: ['stripe.api_key'] })
    const r = validateToolCall(b, 'secrets.read', { secret_key: 'stripe.api_key' })
    expect(r.allowed).toBe(true)
  })

  it('rejects a non-listed secret key', () => {
    const b = bundle({ secrets: ['stripe.api_key'] })
    const r = validateToolCall(b, 'secrets.read', { secret_key: 'github.token' })
    expect(r.allowed).toBe(false)
  })

  it('rejects a wildcard request even if scope contains *', () => {
    const b = bundle({ secrets: ['*'] }) // would be denied at policy compile, but defense in depth
    const r = validateToolCall(b, 'secrets.read', { secret_key: 'stripe.api_key' })
    expect(r.allowed).toBe(false)
  })

  it('rejects wildcards in the request', () => {
    const b = bundle({ secrets: ['stripe.api_key'] })
    const r = validateToolCall(b, 'secrets.read', { secret_key: 'stripe.*' })
    expect(r.allowed).toBe(false)
  })
})

describe('validateToolCall — channels', () => {
  it('matches exact channel name', () => {
    const b = bundle({ channel_post: ['#orb-237'] })
    const r = validateToolCall(b, 'channel.post', { channel: '#orb-237' })
    expect(r.allowed).toBe(true)
  })

  it('matches suffix wildcard', () => {
    const b = bundle({ channel_post: ['#orb-*'] })
    const r = validateToolCall(b, 'channel.post', { channel: '#orb-237' })
    expect(r.allowed).toBe(true)
  })

  it('denies non-matching channel', () => {
    const b = bundle({ channel_post: ['#orb-*'] })
    const r = validateToolCall(b, 'channel.post', { channel: '#exec-only' })
    expect(r.allowed).toBe(false)
  })

  it('inbox.subscribe consults channel_read', () => {
    const b = bundle({ channel_read: ['#sprint-1'] })
    const r = validateToolCall(b, 'inbox.subscribe', { channel: '#sprint-1' })
    expect(r.allowed).toBe(true)
  })
})

describe('validateToolCall — network egress', () => {
  it('matches exact host', () => {
    const b = bundle({ network_egress: ['api.anthropic.com'] })
    const r = validateToolCall(b, 'network.fetch', { url: 'https://api.anthropic.com/v1/messages' })
    expect(r.allowed).toBe(true)
  })

  it('matches *.<domain> pattern', () => {
    const b = bundle({ network_egress: ['*.stripe.com'] })
    const r = validateToolCall(b, 'network.fetch', { url: 'https://api.stripe.com/v1/charges' })
    expect(r.allowed).toBe(true)
  })

  it('denies wildcard *', () => {
    const b = bundle({ network_egress: ['*'] })
    const r = validateToolCall(b, 'network.fetch', { url: 'https://evil.example.com' })
    expect(r.allowed).toBe(false)
  })

  it('denies non-matching host', () => {
    const b = bundle({ network_egress: ['api.anthropic.com'] })
    const r = validateToolCall(b, 'network.fetch', { url: 'https://evil.example.com' })
    expect(r.allowed).toBe(false)
  })
})

describe('validateToolCall — board', () => {
  it('matches ticket:ID in board_read', () => {
    const b = bundle({ board_read: ['ticket:ORB-237'] })
    const r = validateToolCall(b, 'board.read', { target: 'ticket:ORB-237' })
    expect(r.allowed).toBe(true)
  })

  it('matches ticket:*', () => {
    const b = bundle({ board_read: ['ticket:*'] })
    const r = validateToolCall(b, 'board.read', { target: 'ticket:ORB-237' })
    expect(r.allowed).toBe(true)
  })

  it('matches field qualifier', () => {
    const b = bundle({ board_mutate: ['ticket:ORB-237.status'] })
    const r = validateToolCall(b, 'board.mutate', { target: 'ticket:ORB-237', field: 'status' })
    expect(r.allowed).toBe(true)
  })

  it('matches ticket:*.status with field', () => {
    const b = bundle({ board_mutate: ['ticket:*.status'] })
    const r = validateToolCall(b, 'board.mutate', { target: 'ticket:ORB-237', field: 'status' })
    expect(r.allowed).toBe(true)
  })

  it('denies wrong field', () => {
    const b = bundle({ board_mutate: ['ticket:ORB-237.status'] })
    const r = validateToolCall(b, 'board.mutate', { target: 'ticket:ORB-237', field: 'priority' })
    expect(r.allowed).toBe(false)
  })
})

describe('validateToolCall — git_commit', () => {
  it('matches a granted branch+path rule', () => {
    const b = bundle({
      git_commit: [{ branch: 'feature/*', paths: ['src/billing/**'] }],
    })
    const r = validateToolCall(b, 'git.sign_commit', {
      branch: 'feature/orb-237',
      paths: ['src/billing/invoice.ts'],
    })
    expect(r.allowed).toBe(true)
  })

  it('denies if any path is outside the rule', () => {
    const b = bundle({
      git_commit: [{ branch: 'feature/*', paths: ['src/billing/**'] }],
    })
    const r = validateToolCall(b, 'git.sign_commit', {
      branch: 'feature/orb-237',
      paths: ['src/billing/invoice.ts', 'src/admin/users.ts'],
    })
    expect(r.allowed).toBe(false)
  })
})

describe('validateToolCall — unknown tool', () => {
  it('denies any tool not in the allow-list', () => {
    const b = bundle({ files_write: ['**/*'] })
    const r = validateToolCall(b, 'db.execute', { sql: 'DROP TABLE users' })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason_code).toBe('AUTH_UNKNOWN_TOOL')
  })
})

describe('validateToolCall — spawn_subagent', () => {
  it('allows when scope is true', () => {
    const b = bundle({ spawn_subagent: true })
    const r = validateToolCall(b, 'agent.spawn_subagent', { persona: 'qa' })
    expect(r.allowed).toBe(true)
  })

  it('denies when scope is false', () => {
    const b = bundle({ spawn_subagent: false })
    const r = validateToolCall(b, 'agent.spawn_subagent', { persona: 'qa' })
    expect(r.allowed).toBe(false)
  })
})

describe('validateToolCall — verifier SoD runtime', () => {
  it('blocks verifier write to a path it can read', () => {
    const b = bundle(
      { files_read: ['src/**'], files_write: ['src/**'] }, // hypothetical mis-issued
      'verifier',
    )
    const r = validateToolCall(b, 'files.write', { path: 'src/billing/invoice.ts' })
    expect(r.allowed).toBe(false)
    if (!r.allowed) expect(r.reason_code).toBe('AUTH_SOD_VIOLATION')
  })
})
