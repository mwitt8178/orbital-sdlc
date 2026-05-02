/**
 * recovery/backup.ts — encrypted backup tarball export.
 *
 * Moved from cli/backup.ts. Produces a single encrypted tarball containing:
 *   - manifest.json   — versioning + install_id + timestamps
 *   - postgres.dump   — output of `pg_dump -Fc` (custom format) of the orbital DB
 *   - keychain.json   — exported keychain entries (signing keys + tokens)
 *   - install.json    — copy of ~/.orbital/config/install.json
 *   - wal/            — copy of ~/.orbital/backup/wal/ (skipped if empty)
 *
 * Encryption: AES-256-GCM via audit-export/encryption.ts.
 *
 * Passphrase resolution order (priority high → low):
 *   1. keychain entry `backup.passphrase`
 *   2. env BACKUP_PASSPHRASE / ORBITAL_BACKUP_PASSPHRASE
 *   3. explicit `passphrase` option
 *   4. interactive prompt (only when none of the above are set)
 */

import { promises as fs } from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import * as tar from 'tar-stream'
import { Readable } from 'node:stream'
import { uuidv7 } from 'uuidv7'
import { loadEnv, getOrbitalHome } from '../config/env.js'
import { loadOrCreateInstall } from '../config/install.js'
import { getKeychain, KEYCHAIN_SERVICE_NAME } from '../capabilities/keychain.js'
import { encrypt } from '../audit-export/encryption.js'
import { runSync, runSyncBuffer, info, warn, exitWithError, promptSecret } from './io.js'

export interface BackupOptions {
  outPath?: string
  passphrase?: string
  /** Override the docker compose container name. */
  containerName?: string
  /** Override the orbital home (tests). */
  orbitalHomeOverride?: string
  /** Override the WAL source dir; defaults to <home>/backup/wal. */
  walDirOverride?: string
  /**
   * When true, do not close the shared DB pool — used by integration tests.
   * (Backup does not open a pool itself but may call loadOrCreateInstall.)
   */
  keepDbOpen?: boolean
}

const DEFAULT_CONTAINER = 'orbital-postgres'

type DumpStrategy =
  | { kind: 'docker'; container: string }
  | { kind: 'host'; databaseUrl: string }

function detectStrategy(containerName: string): DumpStrategy {
  const dockerOk = runSync('docker', ['--version']).status === 0
  if (dockerOk) {
    const inspect = runSync('docker', ['ps', '--filter', `name=${containerName}`, '--format', '{{.Names}}'])
    if (inspect.status === 0 && inspect.stdout.trim().includes(containerName)) {
      return { kind: 'docker', container: containerName }
    }
  }
  const hostPgDump = runSync('pg_dump', ['--version'])
  if (hostPgDump.status === 0) {
    return { kind: 'host', databaseUrl: loadEnv().DATABASE_URL }
  }
  exitWithError(
    'cannot find pg_dump: container `' +
      containerName +
      '` not running and host pg_dump not installed',
  )
}

function runPgDump(strategy: DumpStrategy): Buffer {
  if (strategy.kind === 'docker') {
    info(`> dumping Postgres via docker exec on ${strategy.container}`)
    const result = runSyncBuffer('docker', [
      'compose', 'exec', '-T', 'postgres',
      'pg_dump', '-U', 'orbital', '-d', 'orbital', '-Fc',
      '--no-owner', '--no-privileges',
    ])
    if (result.status !== 0) {
      exitWithError(
        `docker compose exec pg_dump failed: ${result.stderr.toString('utf-8') || '(no stderr)'}`,
      )
    }
    return result.stdout
  }
  info('> dumping Postgres via host pg_dump')
  const result = runSyncBuffer('pg_dump', [
    '-Fc', '--no-owner', '--no-privileges', strategy.databaseUrl,
  ])
  if (result.status !== 0) {
    exitWithError(`host pg_dump failed: ${result.stderr.toString('utf-8') || '(no stderr)'}`)
  }
  return result.stdout
}

async function exportKeychain(): Promise<Buffer> {
  const kc = await getKeychain()
  const accounts = await kc.listAccounts()
  const dump: Record<string, string> = {}
  for (const account of accounts) {
    const value = await kc.getPassword(account)
    if (value !== null) dump[account] = value
  }
  const payload = {
    service: KEYCHAIN_SERVICE_NAME,
    exported_at: new Date().toISOString(),
    accounts: dump,
  }
  return Buffer.from(JSON.stringify(payload, null, 2), 'utf-8')
}

async function readWalEntries(walDir: string): Promise<Array<{ name: string; data: Buffer }>> {
  try {
    const entries = await fs.readdir(walDir, { withFileTypes: true })
    const out: Array<{ name: string; data: Buffer }> = []
    for (const e of entries) {
      if (!e.isFile()) continue
      const data = await fs.readFile(path.join(walDir, e.name))
      out.push({ name: e.name, data })
    }
    return out
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return []
    throw err
  }
}

async function readInstallJson(orbitalHome: string): Promise<Buffer | null> {
  try {
    return await fs.readFile(path.join(orbitalHome, 'config', 'install.json'))
  } catch (err) {
    if ((err as { code?: string }).code === 'ENOENT') return null
    throw err
  }
}

function pipeTarToBuffer(pack: tar.Pack): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    pack.on('data', (chunk: Buffer) => chunks.push(chunk))
    pack.on('end', () => resolve(Buffer.concat(chunks)))
    pack.on('error', reject)
  })
}

function pushEntry(pack: tar.Pack, name: string, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = pack.entry({ name, size: data.length, mode: 0o600, type: 'file' }, (err) => {
      if (err) reject(err)
      else resolve()
    })
    stream.write(data)
    stream.end()
  })
}

async function buildTarball(parts: {
  manifest: Buffer
  installJson: Buffer | null
  pgDump: Buffer
  keychainJson: Buffer
  walEntries: Array<{ name: string; data: Buffer }>
}): Promise<Buffer> {
  const pack = tar.pack()
  const finished = pipeTarToBuffer(pack)

  await pushEntry(pack, 'manifest.json', parts.manifest)
  if (parts.installJson) {
    await pushEntry(pack, 'install.json', parts.installJson)
  }
  await pushEntry(pack, 'postgres.dump', parts.pgDump)
  await pushEntry(pack, 'keychain.json', parts.keychainJson)
  for (const w of parts.walEntries) {
    await pushEntry(pack, `wal/${w.name}`, w.data)
  }
  pack.finalize()
  return finished
}

async function resolvePassphrase(options: BackupOptions): Promise<string> {
  const kc = await getKeychain()
  const fromKeychain = await kc.getPassword('backup.passphrase')
  if (fromKeychain && fromKeychain.length > 0) return fromKeychain

  const fromEnv = process.env['BACKUP_PASSPHRASE'] ?? process.env['ORBITAL_BACKUP_PASSPHRASE']
  if (fromEnv && fromEnv.length > 0) return fromEnv

  if (options.passphrase && options.passphrase.length > 0) return options.passphrase

  const entered = await promptSecret('Backup passphrase: ')
  if (entered.length === 0) {
    exitWithError('passphrase required for backup encryption')
  }
  return entered
}

function defaultOutputPath(orbitalHome: string): string {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  return path.join(orbitalHome, 'backup', 'snapshots', `orbital-${ts}.tar.enc`)
}

export interface BackupResult {
  outPath: string
  size: number
  installId: string
}

export async function runBackupExport(options: BackupOptions = {}): Promise<BackupResult> {
  info('orbital backup export')

  const orbitalHome = options.orbitalHomeOverride ?? getOrbitalHome()
  const containerName = options.containerName ?? DEFAULT_CONTAINER
  const install = await loadOrCreateInstall()

  const strategy = detectStrategy(containerName)
  const dump = runPgDump(strategy)
  info(`  pg_dump produced ${dump.length} bytes`)

  const installJson = await readInstallJson(orbitalHome)
  const keychainJson = await exportKeychain()
  const walEntries = await readWalEntries(options.walDirOverride ?? path.join(orbitalHome, 'backup', 'wal'))
  if (walEntries.length === 0) {
    info('  no WAL segments found (none to bundle)')
  } else {
    info(`  bundling ${String(walEntries.length)} WAL segments`)
  }

  const manifest = {
    schema_version: 1,
    backup_id: uuidv7(),
    install_id: install.install_id,
    created_at: new Date().toISOString(),
    pg_dump_format: 'custom',
    contents: {
      postgres_dump: 'postgres.dump',
      keychain: 'keychain.json',
      install: installJson ? 'install.json' : null,
      wal_segments: walEntries.length,
    },
    cipher: 'AES-256-GCM',
    kdf: 'scrypt',
  }
  const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf-8')

  const tarball = await buildTarball({
    manifest: manifestBuf,
    installJson,
    pgDump: dump,
    keychainJson,
    walEntries,
  })

  const passphrase = await resolvePassphrase(options)
  const { ciphertext } = await encrypt(tarball, passphrase)

  const out = options.outPath ?? defaultOutputPath(orbitalHome)
  await fs.mkdir(path.dirname(out), { recursive: true, mode: 0o700 })
  await fs.writeFile(out, ciphertext, { mode: 0o600 })

  // Self-test: verify the written file.
  const verifyBuf = await fs.readFile(out)
  if (verifyBuf.length !== ciphertext.length) {
    exitWithError(`written tarball mismatch: wrote ${ciphertext.length} bytes, read back ${verifyBuf.length}`)
  }

  info(`  encrypted backup written to ${out}`)
  info(`  size=${String(ciphertext.length)} bytes  install_id=${install.install_id}`)

  return { outPath: out, size: ciphertext.length, installId: install.install_id }
}

// ---------------------------------------------------------------------------
// Helpers re-exported for restore.ts and integration tests
// ---------------------------------------------------------------------------

/** Pure helper — decrypt + extract tarball entries. */
export async function decryptAndExtract(
  buffer: Buffer,
  passphrase: string,
): Promise<Map<string, Buffer>> {
  const { decrypt } = await import('../audit-export/encryption.js')
  const tarBuf = await decrypt({ ciphertext: buffer, passphrase })
  const extract = tar.extract()
  const out = new Map<string, Buffer>()

  return new Promise((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        out.set(header.name, Buffer.concat(chunks))
        next()
      })
      stream.on('error', reject)
      stream.resume()
    })
    extract.on('finish', () => resolve(out))
    extract.on('error', reject)
    Readable.from(tarBuf).pipe(extract)
  })
}

/** Extract tarball entries from a plaintext (already-decrypted) buffer. */
export async function extractTarball(buffer: Buffer): Promise<Map<string, Buffer>> {
  const extract = tar.extract()
  const out = new Map<string, Buffer>()
  return new Promise((resolve, reject) => {
    extract.on('entry', (header, stream, next) => {
      const chunks: Buffer[] = []
      stream.on('data', (chunk: Buffer) => chunks.push(chunk))
      stream.on('end', () => {
        out.set(header.name, Buffer.concat(chunks))
        next()
      })
      stream.on('error', reject)
      stream.resume()
    })
    extract.on('finish', () => resolve(out))
    extract.on('error', reject)
    Readable.from(buffer).pipe(extract)
  })
}

/** Decrypt a buffer using the canonical audit-export encryption module. */
export async function decryptBuffer(buffer: Buffer, passphrase: string): Promise<Buffer> {
  const { decrypt } = await import('../audit-export/encryption.js')
  return decrypt({ ciphertext: buffer, passphrase })
}

/** Run pg_restore from a dump buffer. Used by restore.ts. */
export function dropAndRestore(strategy: ReturnType<typeof detectStrategy>, dump: Buffer): void {
  if (strategy.kind === 'docker') {
    info('> resetting target database via docker exec')
    const reset = runSync(
      'docker',
      [
        'compose', 'exec', '-T', 'postgres',
        'psql', '-U', 'orbital', '-d', 'orbital',
        '-v', 'ON_ERROR_STOP=1',
        '-c',
        'DROP SCHEMA IF EXISTS audit CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    if (reset.status !== 0) {
      exitWithError(`schema reset failed: ${reset.stderr}`)
    }

    info('> running pg_restore via docker exec')
    const result = spawnSync(
      'docker',
      [
        'compose', 'exec', '-T', 'postgres',
        'pg_restore', '-U', 'orbital', '-d', 'orbital',
        '--no-owner', '--no-privileges', '--exit-on-error',
      ],
      { input: dump, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 512 },
    )
    if (result.status !== 0) {
      exitWithError(`pg_restore failed: ${result.stderr?.toString() ?? '(no stderr)'}`)
    }
  } else if (strategy.kind === 'host') {
    info('> resetting target database via host psql')
    const reset = runSync(
      'psql',
      [
        strategy.databaseUrl,
        '-v', 'ON_ERROR_STOP=1',
        '-c',
        'DROP SCHEMA IF EXISTS audit CASCADE; DROP SCHEMA public CASCADE; CREATE SCHEMA public;',
      ],
    )
    if (reset.status !== 0) {
      exitWithError(`schema reset failed: ${reset.stderr}`)
    }

    info('> running pg_restore via host')
    const result = spawnSync(
      'pg_restore',
      ['-d', strategy.databaseUrl, '--no-owner', '--no-privileges', '--exit-on-error'],
      { input: dump, stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1024 * 1024 * 512 },
    )
    if (result.status !== 0) {
      exitWithError(`pg_restore failed: ${result.stderr?.toString() ?? '(no stderr)'}`)
    }
  }
}

export { detectStrategy }
