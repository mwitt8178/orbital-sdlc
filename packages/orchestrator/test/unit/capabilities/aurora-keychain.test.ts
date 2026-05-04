/**
 * aurora-keychain.test.ts — AuroraKeychain unit tests.
 *
 * [Engineer-Principal · Opus · run-keychain-aurora]
 *
 * Verifies:
 *   - round-trip set/get returns the same plaintext
 *   - getPassword on a missing account returns null
 *   - delete removes the row, second delete returns false
 *   - listAccounts returns only the calling tenant's accounts
 *   - tenant-bleed: tenant T1 cannot read T2's credentials
 *   - idempotent set: second set overwrites cleanly with a fresh IV
 *
 * Uses the in-memory KeychainStore seam to keep drizzle out of unit tests.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

import {
  AuroraKeychain,
  resetKeychainCache,
  type KeychainStore,
  type CredentialRow,
} from '../../../src/capabilities/keychain.js'

class InMemoryStore implements KeychainStore {
  rows = new Map<string, CredentialRow>()
  private k(tenantId: string, account: string) {
    return `${tenantId}::${account}`
  }
  async upsert(tenantId: string, account: string, row: CredentialRow): Promise<void> {
    this.rows.set(this.k(tenantId, account), {
      ciphertext: Buffer.from(row.ciphertext),
      iv: Buffer.from(row.iv),
      authTag: Buffer.from(row.authTag),
    })
  }
  async get(tenantId: string, account: string): Promise<CredentialRow | null> {
    return this.rows.get(this.k(tenantId, account)) ?? null
  }
  async delete(tenantId: string, account: string): Promise<boolean> {
    return this.rows.delete(this.k(tenantId, account))
  }
  async listAccounts(tenantId: string): Promise<string[]> {
    const out: string[] = []
    for (const key of this.rows.keys()) {
      const [t, account] = key.split('::')
      if (t === tenantId) out.push(account!)
    }
    return out
  }
}

const TENANT_A = '00000000-0000-0000-0000-00000000000a'
const TENANT_B = '00000000-0000-0000-0000-00000000000b'

const FAKE_KEY = randomBytes(32)
const masterKeyOverride = async () => FAKE_KEY

describe('AuroraKeychain', () => {
  let store: InMemoryStore

  beforeEach(() => {
    resetKeychainCache()
    store = new InMemoryStore()
  })

  function kc(tenantId: string) {
    return new AuroraKeychain({
      tenantId,
      store,
      loadMasterKeyOverride: masterKeyOverride,
    })
  }

  it('round-trips a stored secret', async () => {
    const a = kc(TENANT_A)
    await a.setPassword('anthropic.api_key', 'sk-ant-xyz')
    expect(await a.getPassword('anthropic.api_key')).toBe('sk-ant-xyz')
  })

  it('returns null for a missing account', async () => {
    const a = kc(TENANT_A)
    expect(await a.getPassword('does-not-exist')).toBeNull()
  })

  it('overwrites idempotently with a fresh IV', async () => {
    const a = kc(TENANT_A)
    await a.setPassword('k', 'v1')
    const ivBefore = Buffer.from(store.rows.get(`${TENANT_A}::k`)!.iv)
    await a.setPassword('k', 'v2')
    expect(store.rows.size).toBe(1)
    expect(await a.getPassword('k')).toBe('v2')
    const ivAfter = Buffer.from(store.rows.get(`${TENANT_A}::k`)!.iv)
    expect(ivAfter.equals(ivBefore)).toBe(false)
  })

  it('deletes a stored secret', async () => {
    const a = kc(TENANT_A)
    await a.setPassword('k', 'v')
    expect(await a.deletePassword('k')).toBe(true)
    expect(await a.getPassword('k')).toBeNull()
    expect(await a.deletePassword('k')).toBe(false)
  })

  it('listAccounts returns only the calling tenant accounts', async () => {
    const a = kc(TENANT_A)
    const b = kc(TENANT_B)
    await a.setPassword('a1', 'x')
    await a.setPassword('a2', 'y')
    await b.setPassword('b1', 'z')

    const aList = (await a.listAccounts()).sort()
    expect(aList).toEqual(['a1', 'a2'])

    const bList = await b.listAccounts()
    expect(bList).toEqual(['b1'])
  })

  it('tenant-bleed: T1 cannot read T2 credentials', async () => {
    const a = kc(TENANT_A)
    const b = kc(TENANT_B)
    await a.setPassword('shared-account-name', 'A-secret')
    await b.setPassword('shared-account-name', 'B-secret')

    expect(await a.getPassword('shared-account-name')).toBe('A-secret')
    expect(await b.getPassword('shared-account-name')).toBe('B-secret')

    // Delete on T1 must not affect T2.
    expect(await a.deletePassword('shared-account-name')).toBe(true)
    expect(await a.getPassword('shared-account-name')).toBeNull()
    expect(await b.getPassword('shared-account-name')).toBe('B-secret')
  })

  it('rejects tampered ciphertext (auth-tag verification)', async () => {
    const a = kc(TENANT_A)
    await a.setPassword('k', 'plaintext')
    const row = store.rows.get(`${TENANT_A}::k`)!
    // Flip a byte in the ciphertext.
    row.ciphertext[0] = row.ciphertext[0] ^ 0xff
    await expect(a.getPassword('k')).rejects.toThrow()
  })
})
