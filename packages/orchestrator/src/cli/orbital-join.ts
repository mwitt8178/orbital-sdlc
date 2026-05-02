#!/usr/bin/env node
/**
 * orbital-join — Local-side CLI to pair this install with a hub.
 *
 * Round 7-03 — Federation Auth (Identity & Pairing)
 * [Engineer-Principal · Opus · run-round7-03-federation-auth]
 *
 * Usage:
 *   orbital join <invite-url> [--display-name "matt-laptop"]
 *
 * Flow:
 *   1. Parse the URL: extract hub origin + invite token from the path.
 *   2. Generate or load this install's keypair (~/.orbital/keys/install.json).
 *      File is mode 0600. Private key never leaves disk; only the public
 *      half goes over the wire.
 *   3. POST { install_id, public_key, display_name, invite_token } to
 *      <hub>/hub/register.
 *   4. On success, print confirmation + persist the (already-on-disk) key
 *      pair. Subsequent `orbital` commands will sign requests with this key.
 *   5. On already-paired errors, instruct the operator to ask an owner to
 *      revoke their previous registration first.
 *
 * Hard rule: the private key NEVER appears in any log line, any HTTP body,
 * or any error message. Only public_key and install_id are emitted.
 */

import {
  getOrCreateInstallKey,
  defaultInstallKeyPath,
} from '../keys/install-key.js'
import { bytesToBase64Url } from '../keys/envelope.js'
import os from 'node:os'

interface ParsedArgs {
  inviteUrl: string
  displayName: string
}

interface RegisterResponseOk {
  ok: true
  install_id: string
  tenant_id: string
  role: 'owner' | 'member' | 'viewer'
  hub_pubkey: string
}

interface RegisterResponseErr {
  ok: false
  code: string
  message: string
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2)
  if (args.length === 0 || args[0] === undefined) {
    throw new Error(
      `Usage: orbital join <invite-url> [--display-name <name>]\n` +
        `  Example: orbital join https://orbital.team.dev/join/eyJ0...`,
    )
  }

  const inviteUrl = args[0]
  let displayName = os.hostname()

  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--display-name') {
      const next = args[i + 1]
      if (!next) throw new Error(`--display-name requires a value`)
      displayName = next
      i++
    } else {
      throw new Error(`Unknown arg: ${args[i]}`)
    }
  }

  return { inviteUrl, displayName }
}

interface ParsedInvite {
  hubOrigin: string
  inviteToken: string
}

function parseInviteUrl(raw: string): ParsedInvite {
  let url: URL
  try {
    url = new URL(raw)
  } catch (err) {
    throw new Error(`Not a valid URL: ${(err as Error).message}`)
  }

  // Path shape: /join/<token>
  const m = url.pathname.match(/^\/join\/(.+)$/)
  if (!m || !m[1]) {
    throw new Error(`Invite URL must contain '/join/<token>' (got path '${url.pathname}')`)
  }

  return {
    hubOrigin: `${url.protocol}//${url.host}`,
    inviteToken: m[1],
  }
}

async function postRegister(
  hubOrigin: string,
  payload: {
    install_id: string
    public_key: string
    display_name: string
    invite_token: string
  },
): Promise<RegisterResponseOk | RegisterResponseErr> {
  const url = `${hubOrigin}/hub/register`
  const body = JSON.stringify(payload)
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
    signal: AbortSignal.timeout(15_000),
  })

  let parsed: unknown
  try {
    parsed = await res.json()
  } catch (err) {
    throw new Error(`Hub returned non-JSON response (HTTP ${res.status}): ${(err as Error).message}`)
  }

  // Hub responds with the same RegistrationResult shape we expose at the API.
  return parsed as RegisterResponseOk | RegisterResponseErr
}

async function main(): Promise<void> {
  const { inviteUrl, displayName } = parseArgs(process.argv)
  const { hubOrigin, inviteToken } = parseInviteUrl(inviteUrl)

  process.stdout.write(`Hub: ${hubOrigin}\n`)
  process.stdout.write(`Generating keypair (if not already present)...\n`)

  const key = await getOrCreateInstallKey()
  // Public key only — NEVER touch the private key for output.
  const publicKeyB64 = bytesToBase64Url(key.publicKey)

  process.stdout.write(`  install_id: ${key.installId}\n`)
  process.stdout.write(`  public_key fingerprint: ${publicKeyB64.slice(0, 16)}...\n`)
  process.stdout.write(`  key file: ${defaultInstallKeyPath()}\n`)

  process.stdout.write(`Sending registration request...\n`)

  const result = await postRegister(hubOrigin, {
    install_id: key.installId,
    public_key: publicKeyB64,
    display_name: displayName,
    invite_token: inviteToken,
  })

  if (!result.ok) {
    process.stderr.write(`Registration failed: ${result.code} — ${result.message}\n`)
    if (result.code === 'AUTH_INVITE_ALREADY_USED') {
      process.stderr.write(
        `Hint: ask an owner to run \`orbital admin installs revoke ${key.installId}\` ` +
          `then re-mint an invite, then re-run \`orbital join\`.\n`,
      )
    }
    process.exit(2)
  }

  process.stdout.write(`\nJoined hub successfully.\n`)
  process.stdout.write(`  tenant_id: ${result.tenant_id}\n`)
  process.stdout.write(`  role: ${result.role}\n`)
  process.stdout.write(`  hub fingerprint: ${result.hub_pubkey}\n`)
  process.stdout.write(
    `\nSet ORBITAL_HUB_URL=${hubOrigin} (and ORBITAL_HUB_TENANT_ID=${result.tenant_id}) ` +
      `in your environment to start using the hub from Orbital UI.\n`,
  )
}

main().catch((err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err)
  process.stderr.write(`orbital-join: ${msg}\n`)
  process.exit(1)
})
