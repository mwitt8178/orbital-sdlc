/**
 * recovery/restore.ts — emergency database restore.
 *
 * Moved from cli/restore.ts. This module is the only code path that must
 * work when the daemon is dead. It does not import the Fastify / tRPC stack.
 *
 * Sequence:
 *   1. Refuse if the daemon is up (GET /health on configured PORT).
 *   2. Call restore-guard to check for non-empty DB (bypass with force).
 *   3. Decrypt tarball.
 *   4. Inspect manifest; print summary.
 *   5. Drop schemas + pg_restore.
 *   6. Restore keychain entries.
 *   7. Restore install.json under ~/.orbital/config/.
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { loadEnv, getOrbitalHome } from '../config/env.js'
import { getKeychain } from '../capabilities/keychain.js'
import { resetInstallCache } from '../config/install.js'
import { info, warn, exitWithError, promptSecret } from './io.js'
import { decryptBuffer, extractTarball, detectStrategy, dropAndRestore } from './backup.js'

export interface RestoreOptions {
  fromPath: string
  passphrase?: string
  containerName?: string
  /** Skip the daemon-running check (tests). */
  forceWhileRunning?: boolean
  /**
   * When true, bypass the restore-guard non-empty-DB check.
   */
  force?: boolean
  /** Override the orbital home (tests). */
  orbitalHomeOverride?: string
}

const DEFAULT_CONTAINER = 'orbital-postgres'

interface ManifestShape {
  schema_version: number
  backup_id: string
  install_id: string
  created_at: string
  pg_dump_format: string
  cipher: string
  kdf: string
}

interface KeychainExportShape {
  service: string
  exported_at: string
  accounts: Record<string, string>
}

async function checkDaemonNotRunning(): Promise<void> {
  const env = loadEnv()
  const url = `http://localhost:${String(env.PORT)}/health`
  try {
    const ac = new AbortController()
    const t = setTimeout(() => ac.abort(), 1_500)
    const res = await fetch(url, { signal: ac.signal })
    clearTimeout(t)
    if (res.ok) {
      exitWithError(
        `daemon appears to be running at ${url}. Stop it (Ctrl-C) before running restore.`,
      )
    }
  } catch {
    // No daemon — we are clear.
  }
}

async function runRestoreGuard(force: boolean): Promise<void> {
  if (force) {
    warn('--force flag set — skipping restore-guard non-empty-DB check')
    return
  }

  let guardModule: { checkRestoreConflict: (opts: { force: boolean }) => Promise<void> }
  try {
    guardModule = (await import('../audit-export/restore-guard.js')) as unknown as typeof guardModule
  } catch (err) {
    warn(
      'restore-guard module not found — skipping conflict check.\n' +
        `  Error: ${(err as Error).message}`,
    )
    return
  }

  try {
    await guardModule.checkRestoreConflict({ force })
  } catch (err) {
    const e = err as Error
    if (e.message.includes('CONFLICT_RESTORE_NON_EMPTY')) {
      process.stderr.write(
        [
          '',
          'CONFLICT: The database is not empty.',
          '',
          'Running restore will DESTROY all existing data and replace it with',
          'the contents of the backup tarball. This is irreversible.',
          '',
          'Pass --force to bypass this check.',
          '',
        ].join('\n'),
      )
      exitWithError('CONFLICT_RESTORE_NON_EMPTY: pass --force to override', 3)
    }
    throw err
  }
}

async function restoreKeychain(json: Buffer): Promise<number> {
  let parsed: KeychainExportShape
  try {
    parsed = JSON.parse(json.toString('utf-8')) as KeychainExportShape
  } catch (err) {
    exitWithError(`malformed keychain.json in tarball: ${String(err)}`)
  }
  const kc = await getKeychain()
  let count = 0
  for (const [account, value] of Object.entries(parsed.accounts)) {
    await kc.setPassword(account, value)
    count += 1
  }
  return count
}

async function restoreInstallJson(orbitalHome: string, data: Buffer): Promise<void> {
  const dir = path.join(orbitalHome, 'config')
  await fs.mkdir(dir, { recursive: true, mode: 0o700 })
  await fs.writeFile(path.join(dir, 'install.json'), data, { mode: 0o600 })
  resetInstallCache()
}

export interface RestoreResult {
  manifest: ManifestShape
  installId: string
  keychainAccountsRestored: number
}

export async function runRestore(options: RestoreOptions): Promise<RestoreResult> {
  info('orbital restore')

  if (!options.forceWhileRunning) {
    await checkDaemonNotRunning()
  }

  await runRestoreGuard(options.force ?? false)

  const fileBuf = await fs.readFile(options.fromPath)
  let passphrase = options.passphrase
  if (!passphrase) {
    const fromEnv = process.env['ORBITAL_BACKUP_PASSPHRASE']
    passphrase = fromEnv && fromEnv.length > 0 ? fromEnv : await promptSecret('Backup passphrase: ')
  }
  if (!passphrase) {
    exitWithError('passphrase required to decrypt the backup tarball')
  }

  let plaintext: Buffer
  try {
    plaintext = await decryptBuffer(fileBuf, passphrase)
  } catch (err) {
    exitWithError(`decryption failed (wrong passphrase or tampered file): ${(err as Error).message}`, 2)
  }

  const entries = await extractTarball(plaintext)

  const manifestBuf = entries.get('manifest.json')
  if (!manifestBuf) {
    exitWithError('tarball is missing manifest.json — not an Orbital backup')
  }
  const manifest = JSON.parse(manifestBuf.toString('utf-8')) as ManifestShape
  if (manifest.schema_version !== 1) {
    exitWithError(`unsupported backup schema_version=${String(manifest.schema_version)}`)
  }
  info(`  backup_id=${manifest.backup_id}`)
  info(`  source install_id=${manifest.install_id}`)
  info(`  created_at=${manifest.created_at}`)

  const dump = entries.get('postgres.dump')
  if (!dump) {
    exitWithError('tarball is missing postgres.dump — corrupt backup')
  }

  const strategy = detectStrategy(options.containerName ?? DEFAULT_CONTAINER)
  dropAndRestore(strategy, dump)
  info('  Postgres restored')

  const keychainBuf = entries.get('keychain.json')
  let keychainCount = 0
  if (keychainBuf) {
    keychainCount = await restoreKeychain(keychainBuf)
    info(`  keychain restored (${String(keychainCount)} accounts)`)
  } else {
    warn('keychain.json missing from tarball — skipping keychain restore')
  }

  const installJsonBuf = entries.get('install.json')
  if (installJsonBuf) {
    const orbitalHome = options.orbitalHomeOverride ?? getOrbitalHome()
    await restoreInstallJson(orbitalHome, installJsonBuf)
    info(`  install.json restored to ${orbitalHome}/config/install.json`)
  }

  info('')
  info('restore: done')
  info('next step: run `npm run setup` to regenerate keys and open the wizard')

  return {
    manifest,
    installId: manifest.install_id,
    keychainAccountsRestored: keychainCount,
  }
}
