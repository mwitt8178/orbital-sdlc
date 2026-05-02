/**
 * backup-schedule.test.ts — contract tests for the recovery modules.
 *
 * These tests verify the public API shape of the modules that replaced
 * the deprecated cli/ directory. They are deliberately shallow — they
 * confirm exports exist and have the expected types without touching a
 * live database or pg_dump binary.
 *
 * Deep behavioral coverage lives in:
 *   - packages/orchestrator/test/integration/admin/router.integration.test.ts
 *   - packages/orchestrator/test/e2e/dr-roundtrip.e2e.test.ts
 */

import { describe, it, expect } from 'vitest'

describe('recovery/backup module', () => {
  it('exports runBackupExport function', async () => {
    const mod = await import('../../../src/recovery/backup.js')
    expect(typeof mod.runBackupExport).toBe('function')
  })

  it('exports decryptAndExtract helper', async () => {
    const mod = await import('../../../src/recovery/backup.js')
    expect(typeof mod.decryptAndExtract).toBe('function')
  })
})

describe('recovery/init module', () => {
  it('exports runInit function', async () => {
    const mod = await import('../../../src/recovery/init.js')
    expect(typeof mod.runInit).toBe('function')
  })
})

describe('recovery/reset module', () => {
  it('exports runReset function', async () => {
    const mod = await import('../../../src/recovery/reset.js')
    expect(typeof mod.runReset).toBe('function')
  })
})

describe('recovery/verify module', () => {
  it('exports runVerify function', async () => {
    const mod = await import('../../../src/recovery/verify.js')
    expect(typeof mod.runVerify).toBe('function')
  })
})

describe('recovery/keys module', () => {
  it('exports runKeysRotate function', async () => {
    const mod = await import('../../../src/recovery/keys.js')
    expect(typeof mod.runKeysRotate).toBe('function')
  })
})

describe('audit-export/encryption module (canonical AES helper)', () => {
  it('exports encrypt and decrypt', async () => {
    const mod = await import('../../../src/audit-export/encryption.js')
    expect(typeof mod.encrypt).toBe('function')
    expect(typeof mod.decrypt).toBe('function')
  })

  it('round-trips a plaintext buffer', async () => {
    const mod = await import('../../../src/audit-export/encryption.js')
    const plaintext = Buffer.from('orbital-dr-test', 'utf-8')
    const passphrase = 'test-passphrase-123'
    const { ciphertext } = await mod.encrypt(plaintext, passphrase)
    expect(ciphertext.length).toBeGreaterThan(plaintext.length)
    const recovered = await mod.decrypt({ ciphertext, passphrase })
    expect(recovered).toEqual(plaintext)
  })

  it('decrypt throws on wrong passphrase', async () => {
    const mod = await import('../../../src/audit-export/encryption.js')
    const plaintext = Buffer.from('orbital-wrong-passphrase-test', 'utf-8')
    const { ciphertext } = await mod.encrypt(plaintext, 'correct-pass')
    await expect(mod.decrypt({ ciphertext, passphrase: 'wrong-pass' })).rejects.toThrow()
  })
})
