#!/usr/bin/env node
/**
 * orbital-invite — Hub-side CLI to mint pairing invite tokens.
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Usage:
 *   orbital invite create --role member [--hub https://orbital.team.dev] [--ttl 24h]
 *
 * Output:
 *   Invite URL: https://orbital.team.dev/join/<jwt>  (valid until <iso ts>, single-use)
 *
 * Requires:
 *   ORBITAL_HUB_MASTER_KEY env var present (set by scripts/hub-bootstrap.sh).
 *   Script must run on the hub host (or any host with access to that secret).
 *
 * The minted token is HS256-signed with the hub master key. Single-use is
 * enforced by the unique index on known_installs.invite_jti at registration time.
 */

import { mintInvite } from '../hub/auth/registration.js'
import { loadEnv } from '../config/env.js'

interface ParsedArgs {
  role: 'owner' | 'member' | 'viewer'
  hub: string | null
  ttlSec: number
  tenantId: string
}

function parseTtl(s: string): number {
  // Accept "24h", "1d", "30m", "60s", or raw seconds
  const m = s.match(/^(\d+)([smhd])?$/i)
  if (!m) throw new Error(`invalid --ttl '${s}': use formats like 24h, 1d, 30m, 60s, or raw seconds`)
  const n = parseInt(m[1] as string, 10)
  const unit = (m[2] ?? 's').toLowerCase()
  switch (unit) {
    case 's':
      return n
    case 'm':
      return n * 60
    case 'h':
      return n * 3600
    case 'd':
      return n * 86_400
    default:
      throw new Error(`invalid ttl unit '${unit}'`)
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  // We expect: ['create', '--role', 'member', '--hub', 'url', '--ttl', '24h', '--tenant', 'uuid']
  const args = argv.slice(2)
  if (args[0] !== 'create') {
    throw new Error(`Usage: orbital invite create --role <owner|member|viewer> [--hub <url>] [--ttl <duration>] [--tenant <uuid>]`)
  }

  const env = loadEnv()
  const result: ParsedArgs = {
    role: 'member',
    hub: null,
    ttlSec: 24 * 3600,
    tenantId: env.ORBITAL_HUB_TENANT_ID,
  }
  for (let i = 1; i < args.length; i++) {
    const a = args[i]
    const next = args[i + 1]
    switch (a) {
      case '--role':
        if (!next || !['owner', 'member', 'viewer'].includes(next)) {
          throw new Error(`--role must be owner|member|viewer (got '${next ?? ''}')`)
        }
        result.role = next as 'owner' | 'member' | 'viewer'
        i++
        break
      case '--hub':
        if (!next) throw new Error(`--hub requires a URL`)
        result.hub = next.replace(/\/$/, '')
        i++
        break
      case '--ttl':
        if (!next) throw new Error(`--ttl requires a value`)
        result.ttlSec = parseTtl(next)
        i++
        break
      case '--tenant':
        if (!next) throw new Error(`--tenant requires a UUID`)
        result.tenantId = next
        i++
        break
      default:
        throw new Error(`Unknown arg: ${a}`)
    }
  }
  return result
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv)
  const hubUrl = args.hub ?? process.env['ORBITAL_HUB_URL'] ?? 'https://localhost'

  const { token, claims } = mintInvite({
    tenantId: args.tenantId,
    role: args.role,
    ttlSec: args.ttlSec,
  })

  const url = `${hubUrl}/join/${token}`
  const expiry = new Date(claims.exp * 1000).toISOString()

  // Print human-friendly + machine-friendly forms
  process.stdout.write(`Invite URL: ${url}\n`)
  process.stdout.write(`  role: ${claims.role}\n`)
  process.stdout.write(`  tenant_id: ${claims.tenant_id}\n`)
  process.stdout.write(`  jti: ${claims.jti}\n`)
  process.stdout.write(`  expires_at: ${expiry}\n`)
  process.stdout.write(`  single-use: yes (jti is recorded in known_installs.invite_jti)\n`)
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`orbital-invite: ${msg}\n`)
  process.exit(1)
})
