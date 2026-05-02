/**
 * unit/admin/auth.test.ts — admin token auth middleware unit tests.
 *
 * Real keychain shim (file-backed) per CLAUDE.md test rules — no mocks.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import {
  authorizeAdminRequest,
  resolveConfiguredAdminToken,
  ADMIN_TOKEN_KEYCHAIN_ACCOUNT,
  _resetOpenModeWarning,
} from '../../../src/admin/auth.js'
import { getKeychain, resetKeychainCache } from '../../../src/capabilities/keychain.js'

const TEST_SHIM = path.join(os.homedir(), `.orbital-test-keychain-admin-auth-${process.pid}.json`)

let originalAdminToken: string | undefined
let originalKeychainPath: string | undefined
let originalNodeEnv: string | undefined

beforeEach(async () => {
  originalAdminToken = process.env['ADMIN_TOKEN']
  originalKeychainPath = process.env['ORBITAL_TEST_KEYCHAIN_PATH']
  originalNodeEnv = process.env['NODE_ENV']
  delete process.env['ADMIN_TOKEN']
  process.env['ORBITAL_TEST_KEYCHAIN'] = '1'
  process.env['ORBITAL_TEST_KEYCHAIN_PATH'] = TEST_SHIM
  resetKeychainCache()
  _resetOpenModeWarning()
  await fs.unlink(TEST_SHIM).catch(() => undefined)
})

afterEach(async () => {
  await fs.unlink(TEST_SHIM).catch(() => undefined)
  if (originalAdminToken === undefined) delete process.env['ADMIN_TOKEN']
  else process.env['ADMIN_TOKEN'] = originalAdminToken
  if (originalKeychainPath === undefined) delete process.env['ORBITAL_TEST_KEYCHAIN_PATH']
  else process.env['ORBITAL_TEST_KEYCHAIN_PATH'] = originalKeychainPath
  if (originalNodeEnv === undefined) delete process.env['NODE_ENV']
  else process.env['NODE_ENV'] = originalNodeEnv
  resetKeychainCache()
})

describe('admin/auth resolveConfiguredAdminToken', () => {
  it('returns null when neither keychain nor env is set', async () => {
    const t = await resolveConfiguredAdminToken()
    expect(t).toBeNull()
  })

  it('reads from env when only env is set', async () => {
    process.env['ADMIN_TOKEN'] = 'env-token-abc'
    const t = await resolveConfiguredAdminToken()
    expect(t).toBe('env-token-abc')
  })

  it('reads from keychain when only keychain is set', async () => {
    const kc = await getKeychain()
    await kc.setPassword(ADMIN_TOKEN_KEYCHAIN_ACCOUNT, 'kc-token-xyz')
    const t = await resolveConfiguredAdminToken()
    expect(t).toBe('kc-token-xyz')
  })

  it('prefers keychain over env when both are set', async () => {
    process.env['ADMIN_TOKEN'] = 'env-token-loses'
    const kc = await getKeychain()
    await kc.setPassword(ADMIN_TOKEN_KEYCHAIN_ACCOUNT, 'kc-token-wins')
    const t = await resolveConfiguredAdminToken()
    expect(t).toBe('kc-token-wins')
  })
})

describe('admin/auth authorizeAdminRequest', () => {
  it('AUTH_OPEN_DEV when no token configured AND NODE_ENV=development', async () => {
    const result = await authorizeAdminRequest(undefined, 'development')
    expect(result.allowed).toBe(true)
    expect(result.reasonCode).toBe('AUTH_OPEN_DEV')
  })

  it('AUTH_MISSING_TOKEN when no token configured AND NODE_ENV=production', async () => {
    const result = await authorizeAdminRequest(undefined, 'production')
    expect(result.allowed).toBe(false)
    expect(result.reasonCode).toBe('AUTH_MISSING_TOKEN')
  })

  it('AUTH_MISSING_TOKEN when token configured but caller did not provide one', async () => {
    process.env['ADMIN_TOKEN'] = 'right-token'
    const result = await authorizeAdminRequest(undefined, 'development')
    expect(result.allowed).toBe(false)
    expect(result.reasonCode).toBe('AUTH_MISSING_TOKEN')
  })

  it('AUTH_BAD_TOKEN when token configured but caller provided wrong one', async () => {
    process.env['ADMIN_TOKEN'] = 'right-token'
    const result = await authorizeAdminRequest('wrong-token', 'development')
    expect(result.allowed).toBe(false)
    expect(result.reasonCode).toBe('AUTH_BAD_TOKEN')
  })

  it('AUTH_OK when token configured and caller provided matching token', async () => {
    process.env['ADMIN_TOKEN'] = 'right-token'
    const result = await authorizeAdminRequest('right-token', 'development')
    expect(result.allowed).toBe(true)
    expect(result.reasonCode).toBe('AUTH_OK')
  })

  it('AUTH_OK against keychain-configured token', async () => {
    const kc = await getKeychain()
    await kc.setPassword(ADMIN_TOKEN_KEYCHAIN_ACCOUNT, 'kc-secret')
    const result = await authorizeAdminRequest('kc-secret', 'production')
    expect(result.allowed).toBe(true)
    expect(result.reasonCode).toBe('AUTH_OK')
  })

  it('AUTH_BAD_TOKEN distinguishes length-equal mismatches in constant time', async () => {
    process.env['ADMIN_TOKEN'] = 'aaaaaaaa'
    const result = await authorizeAdminRequest('bbbbbbbb', 'development')
    expect(result.allowed).toBe(false)
    expect(result.reasonCode).toBe('AUTH_BAD_TOKEN')
  })

  it('AUTH_BAD_TOKEN when token lengths differ', async () => {
    process.env['ADMIN_TOKEN'] = 'short'
    const result = await authorizeAdminRequest('much-longer-token', 'development')
    expect(result.allowed).toBe(false)
    expect(result.reasonCode).toBe('AUTH_BAD_TOKEN')
  })
})
