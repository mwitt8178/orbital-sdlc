/**
 * test/integration/hub/cli-join.integration.test.ts
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * End-to-end CLI test:
 *   1. Spin up a Fastify hub with /hub/register wired to registerHandler.
 *   2. Run `orbital invite create` via execFile, capture the printed URL.
 *   3. Substitute the printed hub URL with our fixture's URL.
 *   4. Run `orbital join <fixture-url>` via execFile.
 *   5. Verify a known_installs row was inserted by the join.
 *   6. Verify a subsequent authenticated tRPC-style request signed by the
 *      newly-paired install passes envelope verification.
 *
 * No mocks — real Postgres, real crypto, real subprocess invocation.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import path from 'node:path'
import fs from 'node:fs/promises'
import os from 'node:os'
import Fastify from 'fastify'
import type { FastifyInstance } from 'fastify'
import { eq } from 'drizzle-orm'

import { sql, db, closeDb } from '../../../src/db/client.js'
import { knownInstalls } from '../../../src/db/schema/known-installs.js'
import { registerHandler } from '../../../src/hub/auth/registration.js'
import {
  signEnvelope,
  base64UrlToBytes,
  HEADER_INSTALL_ID,
  HEADER_SIG,
  HEADER_SIG_BODY,
} from '../../../src/keys/envelope.js'
import { verifyRequest, _resetNonceLru } from '../../../src/hub/auth/middleware.js'
import { resetEnvCache } from '../../../src/config/env.js'
import { loadInstallKey } from '../../../src/keys/install-key.js'

const execFileAsync = promisify(execFile)

const TEST_MASTER_KEY = 'cli-test-hub-master-key-0123456789abcdef0123456789abcdef'
// Per-file tenant id so parallel test suites don't wipe each other's rows
const TEST_TENANT_ID = '00000000-0000-0000-0000-000000333333'

let hubApp: FastifyInstance
let hubUrl: string
let workspaceRoot: string
let cliInvitePath: string
let cliJoinPath: string
let testInstallKeyPath: string

beforeAll(async () => {
  // Resolve paths
  workspaceRoot = path.resolve(__dirname, '..', '..', '..', '..', '..')
  cliInvitePath = path.join(
    workspaceRoot,
    'packages',
    'orchestrator',
    'src',
    'cli',
    'orbital-invite.ts',
  )
  cliJoinPath = path.join(
    workspaceRoot,
    'packages',
    'orchestrator',
    'src',
    'cli',
    'orbital-join.ts',
  )
  testInstallKeyPath = path.join(
    os.tmpdir(),
    `orbital-cli-join-test-install-${process.pid}.json`,
  )
  // Clean any previous run
  await fs.unlink(testInstallKeyPath).catch(() => undefined)

  process.env['ORBITAL_HUB_MASTER_KEY'] = TEST_MASTER_KEY
  process.env['ORBITAL_HUB_TENANT_ID'] = TEST_TENANT_ID
  resetEnvCache()

  // Bootstrap table
  await sql`SELECT pg_advisory_lock(7030034)`
  try {
    await sql.unsafe(`
      CREATE TABLE IF NOT EXISTS known_installs (
        install_id    uuid        PRIMARY KEY,
        tenant_id     uuid        NOT NULL DEFAULT '00000000-0000-0000-0000-000000000000',
        public_key    text        NOT NULL,
        role          text        NOT NULL CHECK (role IN ('owner','member','viewer')),
        display_name  text,
        invite_jti    text        NOT NULL,
        joined_at     timestamptz NOT NULL DEFAULT now(),
        last_seen_at  timestamptz,
        revoked_at    timestamptz
      )
    `)
    await sql.unsafe(`
      CREATE UNIQUE INDEX IF NOT EXISTS known_installs_invite_jti_uniq
        ON known_installs (invite_jti)
    `)
  } finally {
    await sql`SELECT pg_advisory_unlock(7030034)`
  }

  // Build the hub fixture with /hub/register wired to registerHandler.
  hubApp = Fastify({ logger: false, bodyLimit: 1024 * 1024 })
  hubApp.post('/hub/register', async (req, reply) => {
    const result = await registerHandler(req.body as Parameters<typeof registerHandler>[0])
    if (result.ok) {
      void reply.status(200).send(result)
    } else {
      void reply.status(400).send(result)
    }
  })

  await hubApp.listen({ port: 0, host: '127.0.0.1' })
  const address = hubApp.server.address()
  if (!address || typeof address === 'string') {
    throw new Error('hub fixture: failed to obtain listening address')
  }
  hubUrl = `http://127.0.0.1:${address.port}`
}, 30_000)

afterAll(async () => {
  await hubApp?.close().catch(() => undefined)
  await fs.unlink(testInstallKeyPath).catch(() => undefined)
  await closeDb()
})

beforeEach(async () => {
  // Only delete rows scoped to this file's tenant so parallel test suites
  // don't collide.
  await sql`DELETE FROM known_installs WHERE tenant_id = ${TEST_TENANT_ID}`
  _resetNonceLru()
  await fs.unlink(testInstallKeyPath).catch(() => undefined)
})

interface CliRunResult {
  stdout: string
  stderr: string
  code: number | null
}

async function runCli(
  scriptPath: string,
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<CliRunResult> {
  const tsxBin = path.join(workspaceRoot, 'node_modules', '.bin', 'tsx')
  try {
    const res = await execFileAsync(tsxBin, [scriptPath, ...args], {
      env: {
        ...process.env,
        ORBITAL_HUB_MASTER_KEY: TEST_MASTER_KEY,
        ORBITAL_HUB_TENANT_ID: TEST_TENANT_ID,
        ORBITAL_HUB_URL: hubUrl,
        ORBITAL_INSTALL_KEY_PATH: testInstallKeyPath,
        NODE_ENV: 'test',
        ...envOverrides,
      },
      cwd: workspaceRoot,
      timeout: 30_000,
    })
    return { stdout: res.stdout, stderr: res.stderr, code: 0 }
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number }
    return {
      stdout: e.stdout ?? '',
      stderr: e.stderr ?? '',
      code: typeof e.code === 'number' ? e.code : 1,
    }
  }
}

describe('CLI: orbital invite create + orbital join', () => {
  it('runs `orbital invite create --role member` and prints an invite URL', async () => {
    const res = await runCli(cliInvitePath, [
      'create',
      '--role',
      'member',
      '--hub',
      hubUrl,
      '--tenant',
      TEST_TENANT_ID,
    ])

    expect(res.code).toBe(0)
    expect(res.stdout).toMatch(/Invite URL:/)
    expect(res.stdout).toContain(hubUrl)
    expect(res.stdout).toContain('role: member')
  })

  it('end-to-end pairing: invite → join → known_installs row created', async () => {
    // 1. Mint invite
    const invite = await runCli(cliInvitePath, [
      'create',
      '--role',
      'member',
      '--hub',
      hubUrl,
      '--tenant',
      TEST_TENANT_ID,
    ])
    expect(invite.code).toBe(0)

    const urlMatch = invite.stdout.match(/Invite URL:\s+(\S+)/)
    expect(urlMatch).not.toBeNull()
    const inviteUrl = urlMatch![1]!

    // 2. Run orbital join
    const join = await runCli(cliJoinPath, [inviteUrl, '--display-name', 'cli-test-laptop'])
    if (join.code !== 0) {
      // Print stderr so we can debug if this ever flakes
      // eslint-disable-next-line no-console
      console.error('orbital join stderr:', join.stderr)
    }
    expect(join.code).toBe(0)
    expect(join.stdout).toMatch(/Joined hub successfully/)
    expect(join.stdout).toContain('member')

    // 3. Verify the known_installs row exists
    const stored = await loadInstallKey(testInstallKeyPath)
    expect(stored).not.toBeNull()
    const installId = stored!.installId

    const rows = await db
      .select()
      .from(knownInstalls)
      .where(eq(knownInstalls.install_id, installId))
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.role).toBe('member')
    expect(row.display_name).toBe('cli-test-laptop')
    expect(row.revoked_at).toBeNull()

    // 4. The same install can now sign requests that pass auth verification.
    const body = new TextEncoder().encode('{"foo":"bar"}')
    const env = await signEnvelope({
      method: 'tasks.list',
      bodyBytes: body,
      privateKey: stored!.privateKey,
    })
    const headers = {
      [HEADER_INSTALL_ID]: stored!.installId,
      [HEADER_SIG]: env.signatureB64,
      [HEADER_SIG_BODY]: env.bodyB64,
    }
    const verify = await verifyRequest({
      headers,
      requestBodyBytes: body,
    })
    expect(verify.ok).toBe(true)
    if (verify.ok) {
      expect(verify.identity.installId).toBe(installId)
      expect(verify.identity.role).toBe('member')
    }
  }, 30_000)

  it('rejects `orbital join` when the invite is reused', async () => {
    // Mint
    const invite = await runCli(cliInvitePath, [
      'create',
      '--role',
      'member',
      '--hub',
      hubUrl,
      '--tenant',
      TEST_TENANT_ID,
    ])
    const urlMatch = invite.stdout.match(/Invite URL:\s+(\S+)/)
    const inviteUrl = urlMatch![1]!

    // Join once — succeeds
    const j1 = await runCli(cliJoinPath, [inviteUrl, '--display-name', 'first'])
    expect(j1.code).toBe(0)

    // Erase the on-disk install key so the second join generates a fresh one
    await fs.unlink(testInstallKeyPath).catch(() => undefined)

    // Join twice — fails with AUTH_INVITE_ALREADY_USED
    const j2 = await runCli(cliJoinPath, [inviteUrl, '--display-name', 'second'])
    expect(j2.code).not.toBe(0)
    expect(j2.stderr + j2.stdout).toMatch(/AUTH_INVITE_ALREADY_USED/)
  }, 30_000)

  it('writes the install key file with mode 0600', async () => {
    // Mint + join
    const invite = await runCli(cliInvitePath, [
      'create',
      '--role',
      'viewer',
      '--hub',
      hubUrl,
      '--tenant',
      TEST_TENANT_ID,
    ])
    const inviteUrl = invite.stdout.match(/Invite URL:\s+(\S+)/)![1]!
    const join = await runCli(cliJoinPath, [inviteUrl])
    expect(join.code).toBe(0)

    const stat = await fs.stat(testInstallKeyPath)
    const mode = stat.mode & 0o777
    expect(mode).toBe(0o600)
  }, 30_000)

  it('does NOT print the private key in any output line (CI text-search check)', async () => {
    const invite = await runCli(cliInvitePath, [
      'create',
      '--role',
      'member',
      '--hub',
      hubUrl,
      '--tenant',
      TEST_TENANT_ID,
    ])
    const inviteUrl = invite.stdout.match(/Invite URL:\s+(\S+)/)![1]!
    const join = await runCli(cliJoinPath, [inviteUrl, '--display-name', 'audit-test'])
    expect(join.code).toBe(0)

    // Read the on-disk key to find the private_key string we expect to be hidden
    const keyFile = JSON.parse(await fs.readFile(testInstallKeyPath, 'utf-8')) as {
      private_key: string
    }
    expect(keyFile.private_key.length).toBeGreaterThan(20)

    // The private_key text MUST NOT appear in stdout/stderr
    expect(invite.stdout).not.toContain(keyFile.private_key)
    expect(invite.stderr).not.toContain(keyFile.private_key)
    expect(join.stdout).not.toContain(keyFile.private_key)
    expect(join.stderr).not.toContain(keyFile.private_key)

    // And the raw bytes should also not appear (the public key alone is okay)
    const privBytes = base64UrlToBytes(keyFile.private_key)
    const privHex = Buffer.from(privBytes).toString('hex')
    expect(join.stdout).not.toContain(privHex)
    expect(join.stderr).not.toContain(privHex)
  }, 30_000)
})
