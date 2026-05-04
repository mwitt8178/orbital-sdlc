/**
 * vault-sync/store.ts — Storage driver abstraction for the vault.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 *
 * Two implementations land in this PR:
 *   - S3VaultStore: real AWS S3, used by the API + future daemon worker
 *   - InMemoryVaultStore: used by unit tests and the round-trip suite
 *
 * Every method takes a fully qualified key produced by `vaultS3Key()` /
 * `vaultManifestKey()`. The store does NOT compute keys — it only reads + writes.
 * That keeps the tenant-isolation invariant centralised in `key.ts`.
 */

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  DeleteObjectCommand,
  NoSuchKey,
} from '@aws-sdk/client-s3'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import type { Readable } from 'node:stream'

export interface VaultStorePutInput {
  key: string
  body: string
  contentType?: string
  metadata?: Record<string, string>
}

export interface VaultStoreObject {
  key: string
  body: string
  metadata: Record<string, string>
}

export interface VaultStore {
  put(input: VaultStorePutInput): Promise<void>
  get(key: string): Promise<VaultStoreObject | null>
  list(prefix: string): Promise<string[]>
  delete(key: string): Promise<void>
  /** Pre-signed download URL valid for `expiresInSec` seconds. */
  signedDownloadUrl(key: string, expiresInSec: number): Promise<string>
}

// ---------------------------------------------------------------------------
// In-memory store (tests + round-trip suite)
// ---------------------------------------------------------------------------

export function createInMemoryVaultStore(): VaultStore & {
  /** Test helper — direct map access. */
  _map: Map<string, VaultStoreObject>
} {
  const map = new Map<string, VaultStoreObject>()
  return {
    _map: map,
    async put({ key, body, metadata }) {
      map.set(key, { key, body, metadata: metadata ?? {} })
    },
    async get(key) {
      return map.get(key) ?? null
    },
    async list(prefix) {
      const keys: string[] = []
      for (const k of map.keys()) {
        if (k.startsWith(prefix)) keys.push(k)
      }
      return keys.sort()
    },
    async delete(key) {
      map.delete(key)
    },
    async signedDownloadUrl(key, _expiresInSec) {
      return `memory://${key}`
    },
  }
}

// ---------------------------------------------------------------------------
// S3 store
// ---------------------------------------------------------------------------

export interface S3VaultStoreDeps {
  client: S3Client
  bucket: string
}

export function createS3VaultStore(deps: S3VaultStoreDeps): VaultStore {
  const { client, bucket } = deps

  return {
    async put({ key, body, contentType, metadata }) {
      await client.send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: key,
          Body: body,
          ContentType: contentType ?? 'text/markdown; charset=utf-8',
          Metadata: metadata,
          ServerSideEncryption: 'AES256',
        }),
      )
    },
    async get(key) {
      try {
        const out = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }))
        const body = out.Body as Readable | undefined
        if (!body) return null
        const text = await streamToString(body)
        return { key, body: text, metadata: out.Metadata ?? {} }
      } catch (err) {
        if (err instanceof NoSuchKey) return null
        // S3 sometimes surfaces NoSuchKey via the generic error name
        if (err instanceof Error && err.name === 'NoSuchKey') return null
        throw err
      }
    },
    async list(prefix) {
      const keys: string[] = []
      let continuationToken: string | undefined
      do {
        const out = await client.send(
          new ListObjectsV2Command({
            Bucket: bucket,
            Prefix: prefix,
            ContinuationToken: continuationToken,
          }),
        )
        for (const item of out.Contents ?? []) {
          if (item.Key) keys.push(item.Key)
        }
        continuationToken = out.IsTruncated ? out.NextContinuationToken : undefined
      } while (continuationToken)
      return keys
    },
    async delete(key) {
      await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: key }))
    },
    async signedDownloadUrl(key, expiresInSec) {
      return getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucket, Key: key }),
        { expiresIn: expiresInSec },
      )
    },
  }
}

async function streamToString(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    stream.on('data', (chunk: Buffer) => chunks.push(chunk))
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    stream.on('error', reject)
  })
}
