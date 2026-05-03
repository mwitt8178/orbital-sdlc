// [Engineer-Principal · Opus · run-round8-07-secrets-kms]
/**
 * key-rotation/index.ts
 *
 * Lambda handler that rotates the hub master Ed25519 keypair stored in
 * Secrets Manager.
 *
 * Trigger:
 *   - Scheduled by EventBridge every 90 days.
 *   - Also acts as a Secrets Manager rotation Lambda (RotateSecret event)
 *     so admins can trigger manual rotation via the AWS console.
 *
 * Algorithm:
 *   1. Read the current secret value (the active keypair).
 *   2. Generate a new Ed25519 keypair with @noble/ed25519.
 *   3. PutSecretValue on the active secret with the new keypair.
 *   4. PutSecretValue on the `${secret}.prev` companion secret with the OLD
 *      keypair, tagged for 24-hour retention.
 *   5. Old keypair is kept ONLY long enough to verify in-flight signed
 *      envelopes signed before the rotation; after 24h a follow-up cron
 *      schedules the prev secret value for deletion.
 *
 * Secrets Manager rotation protocol (4-step) is implemented for compatibility
 * with `secretsmanager:RotateSecret`:
 *   - createSecret:   create AWSPENDING staging label with new keypair
 *   - setSecret:      no-op (the secret has no DB to set creds against)
 *   - testSecret:     verify the new keypair signs+verifies a probe
 *   - finishSecret:   move AWSPENDING → AWSCURRENT atomically
 *
 * EventBridge-triggered rotation calls the same code path with a synthetic
 * event identifying step="full" which runs all four steps in sequence.
 */

import {
  SecretsManagerClient,
  GetSecretValueCommand,
  PutSecretValueCommand,
  DescribeSecretCommand,
  UpdateSecretVersionStageCommand,
  CreateSecretCommand,
  ResourceExistsException,
} from '@aws-sdk/client-secrets-manager'
import * as ed from '@noble/ed25519'
import { sha512 } from '@noble/hashes/sha512'
import { randomBytes } from 'node:crypto'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SecretsManagerRotationEvent {
  Step: 'createSecret' | 'setSecret' | 'testSecret' | 'finishSecret' | 'full'
  SecretId: string
  ClientRequestToken: string
}

interface KeypairJson {
  publicKey: string
  privateKey: string
  generatedAt: string
  rotationToken?: string
  uninitialized?: boolean
}

interface PrevKeypairJson extends KeypairJson {
  retainUntil: string
}

const PREV_RETENTION_HOURS = 24

// ---------------------------------------------------------------------------
// Required by @noble/ed25519 v2 - synchronous SHA-512 implementation.
// ---------------------------------------------------------------------------
ed.etc.sha512Sync = (...m: Uint8Array[]): Uint8Array =>
  sha512(ed.etc.concatBytes(...m))

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toHex(buf: Uint8Array): string {
  return Array.from(buf)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2)
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return out
}

async function generateKeypair(): Promise<KeypairJson> {
  // Use crypto.randomBytes for a 32-byte private key seed - Ed25519 standard.
  const privateKey = new Uint8Array(randomBytes(32))
  const publicKey = await ed.getPublicKeyAsync(privateKey)
  return {
    publicKey: toHex(publicKey),
    privateKey: toHex(privateKey),
    generatedAt: new Date().toISOString(),
  }
}

async function verifyProbe(keypair: KeypairJson): Promise<boolean> {
  // Sign a deterministic probe and verify - confirms the keypair is well-formed.
  const probe = new TextEncoder().encode('orbital-rotation-probe')
  const sig = await ed.signAsync(probe, fromHex(keypair.privateKey))
  return ed.verifyAsync(sig, probe, fromHex(keypair.publicKey))
}

// ---------------------------------------------------------------------------
// Step implementations
// ---------------------------------------------------------------------------

async function stepCreateSecret(
  client: SecretsManagerClient,
  secretId: string,
  token: string,
): Promise<void> {
  // Idempotency: if a pending version with the same token already exists, skip.
  try {
    await client.send(
      new GetSecretValueCommand({
        SecretId: secretId,
        VersionId: token,
        VersionStage: 'AWSPENDING',
      }),
    )
    // already exists; nothing to do
    return
  } catch {
    // version doesn't exist - proceed to create
  }

  const newKeypair = await generateKeypair()
  await client.send(
    new PutSecretValueCommand({
      SecretId: secretId,
      ClientRequestToken: token,
      SecretString: JSON.stringify(newKeypair),
      VersionStages: ['AWSPENDING'],
    }),
  )
}

function stepSetSecret(): void {
  // For a hub-master-key secret there is no external system to apply the new
  // value to. The keypair lives entirely in Secrets Manager; consumers refresh
  // via secrets-cache TTL.
}

async function stepTestSecret(
  client: SecretsManagerClient,
  secretId: string,
  token: string,
): Promise<void> {
  const result = await client.send(
    new GetSecretValueCommand({
      SecretId: secretId,
      VersionId: token,
      VersionStage: 'AWSPENDING',
    }),
  )
  if (!result.SecretString) {
    throw new Error('testSecret: AWSPENDING value is empty')
  }
  const keypair: KeypairJson = JSON.parse(result.SecretString)
  const ok = await verifyProbe(keypair)
  if (!ok) {
    throw new Error('testSecret: keypair failed sign+verify probe')
  }
}

async function stepFinishSecret(
  client: SecretsManagerClient,
  secretId: string,
  token: string,
): Promise<void> {
  // Capture the OLD AWSCURRENT keypair before promoting AWSPENDING.
  let prevKeypair: KeypairJson | null = null
  try {
    const cur = await client.send(
      new GetSecretValueCommand({ SecretId: secretId, VersionStage: 'AWSCURRENT' }),
    )
    if (cur.SecretString) {
      prevKeypair = JSON.parse(cur.SecretString)
    }
  } catch {
    // No AWSCURRENT yet (first rotation) - nothing to retain.
  }

  // Find the previous AWSCURRENT version id for stage move.
  const desc = await client.send(new DescribeSecretCommand({ SecretId: secretId }))
  const versions = desc.VersionIdsToStages ?? {}
  const currentVersionId = Object.entries(versions).find(([, stages]) =>
    stages?.includes('AWSCURRENT'),
  )?.[0]

  // Promote AWSPENDING → AWSCURRENT (atomic move).
  await client.send(
    new UpdateSecretVersionStageCommand({
      SecretId: secretId,
      VersionStage: 'AWSCURRENT',
      MoveToVersionId: token,
      RemoveFromVersionId: currentVersionId,
    }),
  )

  // Stash the PREVIOUS keypair into ${secret}.prev for the 24h verification
  // window. New verifying code MAY accept signatures from either CURRENT or
  // PREV during that window.
  if (prevKeypair && !prevKeypair.uninitialized) {
    await stashPrev(client, secretId, prevKeypair)
  }
}

async function stashPrev(
  client: SecretsManagerClient,
  secretId: string,
  prevKeypair: KeypairJson,
): Promise<void> {
  const prevSecretId = `${secretId}.prev`
  const prevValue: PrevKeypairJson = {
    ...prevKeypair,
    retainUntil: new Date(Date.now() + PREV_RETENTION_HOURS * 3600 * 1000).toISOString(),
  }

  // Try to update an existing prev secret; if it doesn't exist, create it.
  try {
    await client.send(
      new PutSecretValueCommand({
        SecretId: prevSecretId,
        SecretString: JSON.stringify(prevValue),
      }),
    )
  } catch (err: unknown) {
    if (err instanceof Error && err.name === 'ResourceNotFoundException') {
      try {
        await client.send(
          new CreateSecretCommand({
            Name: prevSecretId,
            Description: 'Orbital hub master key - previous version (24h verification window)',
            SecretString: JSON.stringify(prevValue),
          }),
        )
      } catch (createErr: unknown) {
        if (!(createErr instanceof ResourceExistsException)) {
          throw createErr
        }
      }
    } else {
      throw err
    }
  }
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

export async function handler(event: SecretsManagerRotationEvent): Promise<void> {
  const client = new SecretsManagerClient({})

  if (!event.SecretId) {
    throw new Error('rotation handler: SecretId is required')
  }

  const token = event.ClientRequestToken ?? `manual-${Date.now()}`
  const step = event.Step ?? 'full'

  switch (step) {
    case 'createSecret':
      await stepCreateSecret(client, event.SecretId, token)
      return
    case 'setSecret':
      stepSetSecret()
      return
    case 'testSecret':
      await stepTestSecret(client, event.SecretId, token)
      return
    case 'finishSecret':
      await stepFinishSecret(client, event.SecretId, token)
      return
    case 'full':
    default:
      // EventBridge-triggered: run all four steps end-to-end.
      await stepCreateSecret(client, event.SecretId, token)
      stepSetSecret()
      await stepTestSecret(client, event.SecretId, token)
      await stepFinishSecret(client, event.SecretId, token)
      return
  }
}
