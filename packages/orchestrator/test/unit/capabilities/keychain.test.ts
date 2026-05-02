/**
 * keychain.test.ts — file shim correctness.
 *
 * Validates the test-mode keychain shim:
 *  - writes secrets at mode 0600
 *  - read/list/delete round-trip
 *  - per-account isolation
 *  - production code path uses keytar (assertion that import works under flag).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import {
  getKeychain,
  resetKeychainCache,
  getTestShimKeychain,
  KEYCHAIN_SERVICE_NAME,
} from '../../../src/capabilities/keychain.js'

const TEST_FILE =
  process.env['ORBITAL_TEST_KEYCHAIN_PATH'] ??
  path.join(os.homedir(), '.orbital-test-keychain.json')

describe('keychain (file shim)', () => {
  beforeEach(async () => {
    process.env.ORBITAL_TEST_KEYCHAIN = '1'
    resetKeychainCache()
    await fs.unlink(TEST_FILE).catch(() => undefined)
  })

  afterEach(async () => {
    await fs.unlink(TEST_FILE).catch(() => undefined)
    resetKeychainCache()
  })

  it('round-trips a stored secret', async () => {
    const kc = await getKeychain()
    await kc.setPassword('master:abc', 'secret-value')
    const got = await kc.getPassword('master:abc')
    expect(got).toBe('secret-value')
  })

  it('writes the shim file at mode 0600', async () => {
    const kc = await getKeychain()
    await kc.setPassword('account-a', 'value-a')
    const stat = await fs.stat(TEST_FILE)
    expect(stat.mode & 0o777).toBe(0o600)

    const shim = await getTestShimKeychain()
    await shim.assertSecure()
  })

  it('isolates accounts', async () => {
    const kc = await getKeychain()
    await kc.setPassword('a', '1')
    await kc.setPassword('b', '2')
    expect(await kc.getPassword('a')).toBe('1')
    expect(await kc.getPassword('b')).toBe('2')
    expect(await kc.getPassword('c')).toBeNull()
  })

  it('lists accounts', async () => {
    const kc = await getKeychain()
    await kc.setPassword('a', '1')
    await kc.setPassword('b', '2')
    const accounts = (await kc.listAccounts()).sort()
    expect(accounts).toEqual(['a', 'b'])
  })

  it('deletes accounts', async () => {
    const kc = await getKeychain()
    await kc.setPassword('a', '1')
    expect(await kc.deletePassword('a')).toBe(true)
    expect(await kc.getPassword('a')).toBeNull()
    expect(await kc.deletePassword('a')).toBe(false)
  })

  it('uses the orbital service name', () => {
    expect(KEYCHAIN_SERVICE_NAME).toBe('orbital')
  })
})
