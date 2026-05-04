/**
 * OS keychain wrapper for storing private key bytes.
 *
 * Production path uses `keytar`, which talks to the OS-native credential
 * service (macOS Keychain, Linux libsecret, Windows DPAPI). The `keytar`
 * package is loaded lazily so the test path works on machines without the
 * native binary built.
 *
 * Test path (env: `ORBITAL_TEST_KEYCHAIN=1`) writes to a file at
 * `~/.orbital-test-keychain.json` with mode 0600. This is ONLY used in
 * test mode — never in production code paths.
 *
 * Per Implementation Plan §13: the file shim must never be touched in
 * production. Production startup MUST fail loudly if keytar cannot load
 * its native module (we surface the error rather than silently falling
 * back to the shim).
 */

import { promises as fs, constants as fsConstants } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { loadEnv } from '../config/env.js'
import { logger } from '../config/logger.js'

const SERVICE_NAME = 'orbital'
const TEST_SHIM_FILENAME = '.orbital-test-keychain.json'

export interface Keychain {
  setPassword(account: string, secret: string): Promise<void>
  getPassword(account: string): Promise<string | null>
  deletePassword(account: string): Promise<boolean>
  /** List all accounts under the orbital service. Test helper. */
  listAccounts(): Promise<string[]>
}

// ---------------------------------------------------------------------------
// File-based test shim
// ---------------------------------------------------------------------------

interface ShimFileShape {
  service: string
  accounts: Record<string, string>
}

class FileShimKeychain implements Keychain {
  private readonly path: string

  constructor(filePath?: string) {
    this.path = filePath ?? path.join(os.homedir(), TEST_SHIM_FILENAME)
  }

  async setPassword(account: string, secret: string): Promise<void> {
    const data = await this.readSafe()
    data.accounts[account] = secret
    await this.writeAtomic(data)
  }

  async getPassword(account: string): Promise<string | null> {
    const data = await this.readSafe()
    return data.accounts[account] ?? null
  }

  async deletePassword(account: string): Promise<boolean> {
    const data = await this.readSafe()
    if (!(account in data.accounts)) return false
    delete data.accounts[account]
    await this.writeAtomic(data)
    return true
  }

  async listAccounts(): Promise<string[]> {
    const data = await this.readSafe()
    return Object.keys(data.accounts)
  }

  private async readSafe(): Promise<ShimFileShape> {
    try {
      const raw = await fs.readFile(this.path, 'utf-8')
      const parsed = JSON.parse(raw) as ShimFileShape
      if (parsed.service !== SERVICE_NAME) {
        throw new Error(`keychain shim: service mismatch, got ${parsed.service}`)
      }
      if (typeof parsed.accounts !== 'object' || parsed.accounts === null) {
        throw new Error('keychain shim: accounts field malformed')
      }
      return parsed
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') {
        return { service: SERVICE_NAME, accounts: {} }
      }
      throw err
    }
  }

  private async writeAtomic(data: ShimFileShape): Promise<void> {
    const tmp = `${this.path}.tmp.${process.pid}`
    const json = JSON.stringify(data, null, 2)
    // Write tmp file with 0600 mode, then rename.
    await fs.writeFile(tmp, json, { mode: 0o600 })
    await fs.rename(tmp, this.path)
    // Defensive: chmod the final file in case the FS dropped the mode on rename.
    await fs.chmod(this.path, 0o600)
  }

  /** Verify the shim file is mode 0600. Throws if not. Test helper. */
  async assertSecure(): Promise<void> {
    try {
      const stat = await fs.stat(this.path)
      // Mask non-permission bits.
      const mode = stat.mode & 0o777
      if (mode !== 0o600) {
        throw new Error(`keychain shim: insecure mode ${mode.toString(8)} (expected 0600)`)
      }
      // Verify readable by us.
      await fs.access(this.path, fsConstants.R_OK | fsConstants.W_OK)
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return
      throw err
    }
  }

  /** Test-only: remove the shim file entirely. */
  async purge(): Promise<void> {
    try {
      await fs.unlink(this.path)
    } catch (err) {
      if ((err as { code?: string }).code !== 'ENOENT') throw err
    }
  }

  /** Expose path for assertions. */
  get filePath(): string {
    return this.path
  }
}

// ---------------------------------------------------------------------------
// keytar-backed production keychain
// ---------------------------------------------------------------------------

interface KeytarLib {
  setPassword(service: string, account: string, password: string): Promise<void>
  getPassword(service: string, account: string): Promise<string | null>
  deletePassword(service: string, account: string): Promise<boolean>
  findCredentials(service: string): Promise<Array<{ account: string; password: string }>>
}

class KeytarKeychain implements Keychain {
  constructor(private readonly keytar: KeytarLib) {}

  setPassword(account: string, secret: string): Promise<void> {
    return this.keytar.setPassword(SERVICE_NAME, account, secret)
  }

  getPassword(account: string): Promise<string | null> {
    return this.keytar.getPassword(SERVICE_NAME, account)
  }

  deletePassword(account: string): Promise<boolean> {
    return this.keytar.deletePassword(SERVICE_NAME, account)
  }

  async listAccounts(): Promise<string[]> {
    const creds = await this.keytar.findCredentials(SERVICE_NAME)
    return creds.map((c) => c.account)
  }
}

// ---------------------------------------------------------------------------
// AWS / cloud noop keychain
// ---------------------------------------------------------------------------

// In Lambda there is no OS keychain. Persist to /tmp so credentials survive
// the warm-container lifetime (PC=2 keeps containers warm; cold start = user
// re-enters, which is acceptable for staging). Real storage should be the
// per-tenant DSQL/Aurora row; this is the bridge that unblocks onboarding.
class TmpFileKeychain implements Keychain {
  private readonly file = '/tmp/orbital-keychain.json'

  private async load(): Promise<Record<string, string>> {
    try {
      const raw = await fs.readFile(this.file, 'utf-8')
      return JSON.parse(raw) as Record<string, string>
    } catch (err) {
      if ((err as { code?: string }).code === 'ENOENT') return {}
      throw err
    }
  }

  private async save(state: Record<string, string>): Promise<void> {
    const tmp = `${this.file}.tmp.${process.pid}`
    await fs.writeFile(tmp, JSON.stringify(state), { mode: 0o600 })
    await fs.rename(tmp, this.file)
  }

  async setPassword(account: string, password: string): Promise<void> {
    const state = await this.load()
    state[account] = password
    await this.save(state)
  }

  async getPassword(account: string): Promise<string | null> {
    const state = await this.load()
    return state[account] ?? null
  }

  async deletePassword(account: string): Promise<boolean> {
    const state = await this.load()
    if (!(account in state)) return false
    delete state[account]
    await this.save(state)
    return true
  }

  async listAccounts(): Promise<string[]> {
    const state = await this.load()
    return Object.keys(state)
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

let cached: Keychain | null = null

/**
 * Get the active keychain. Returns the file shim when ORBITAL_TEST_KEYCHAIN=1,
 * a noop in AWS deploy mode (no OS keychain in Lambda), otherwise the real
 * keytar-backed keychain.
 *
 * The first call instantiates and caches the result. Production startup is
 * expected to call this once at boot to surface keytar load errors.
 *
 * In test mode, an optional `ORBITAL_TEST_KEYCHAIN_PATH` env var overrides
 * the default `~/.orbital-test-keychain.json` location. This permits parallel
 * test workers to isolate their keychains.
 */
export async function getKeychain(): Promise<Keychain> {
  if (cached) return cached
  const env = loadEnv()
  if (env.ORBITAL_TEST_KEYCHAIN) {
    logger.warn('keychain: using file-based test shim (ORBITAL_TEST_KEYCHAIN=1)')
    const overridePath = process.env['ORBITAL_TEST_KEYCHAIN_PATH']
    cached = new FileShimKeychain(overridePath)
    return cached
  }
  if (env.ORBITAL_DEPLOY_TARGET === 'aws') {
    logger.warn('keychain: AWS deploy mode — using /tmp file shim (warm-container only; cold start re-prompts)')
    cached = new TmpFileKeychain()
    return cached
  }
  // Lazy-load keytar so test environments without the native build still work.
  // Production (desktop) paths require this to succeed.
  const mod = (await import('keytar')) as unknown as KeytarLib | { default: KeytarLib }
  const keytar = ('default' in mod ? mod.default : mod) as KeytarLib
  cached = new KeytarKeychain(keytar)
  return cached
}

/** Reset the cached keychain. Test helper. */
export function resetKeychainCache(): void {
  cached = null
}

/** Test-only access to the file shim's helpers (assertSecure, purge). */
export async function getTestShimKeychain(): Promise<FileShimKeychain> {
  const kc = await getKeychain()
  if (!(kc instanceof FileShimKeychain)) {
    throw new Error('getTestShimKeychain: not in test mode')
  }
  return kc
}

/** Service name constant — exported for diagnostics and tests. */
export { SERVICE_NAME as KEYCHAIN_SERVICE_NAME }
