/**
 * recovery/io.ts — shared helpers used by backup, restore, reset, and keys-rotate.
 *
 * Extracted from cli/util.ts. Zero interactive prompts here — all onboarding
 * lives in the web UI. The only remaining prompt path is restore's passphrase
 * fallback, kept for emergency DR scenarios when the daemon is dead.
 */

import {
  spawn,
  spawnSync,
  type ChildProcess,
  type SpawnOptions,
  type SpawnSyncOptions,
} from 'node:child_process'
import readline from 'node:readline'
import { Writable } from 'node:stream'

// ---------------------------------------------------------------------------
// Process invocation
// ---------------------------------------------------------------------------

export interface RunResult {
  status: number
  stdout: string
  stderr: string
}

export interface RunBufferResult {
  status: number
  stdout: Buffer
  stderr: Buffer
}

/**
 * Run a child process synchronously, capturing stdout/stderr as strings.
 * Argument arrays are passed verbatim — no shell, no injection surface.
 */
export function runSync(
  cmd: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): RunResult {
  const result = spawnSync(cmd, args as string[], {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf-8',
    ...options,
  })
  const stdout =
    typeof result.stdout === 'string'
      ? result.stdout
      : Buffer.isBuffer(result.stdout)
        ? result.stdout.toString('utf-8')
        : ''
  const stderr =
    typeof result.stderr === 'string'
      ? result.stderr
      : Buffer.isBuffer(result.stderr)
        ? result.stderr.toString('utf-8')
        : ''
  return { status: result.status ?? -1, stdout, stderr }
}

/**
 * Run a child process synchronously, capturing stdout/stderr as Buffers.
 * Used for binary output (pg_dump custom format, etc.).
 */
export function runSyncBuffer(
  cmd: string,
  args: readonly string[],
  options: SpawnSyncOptions = {},
): RunBufferResult {
  const result = spawnSync(cmd, args as string[], {
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 1024 * 1024 * 512,
    ...options,
  })
  const stdout = Buffer.isBuffer(result.stdout)
    ? result.stdout
    : typeof result.stdout === 'string'
      ? Buffer.from(result.stdout)
      : Buffer.alloc(0)
  const stderr = Buffer.isBuffer(result.stderr)
    ? result.stderr
    : typeof result.stderr === 'string'
      ? Buffer.from(result.stderr)
      : Buffer.alloc(0)
  return { status: result.status ?? -1, stdout, stderr }
}

/**
 * Spawn a child process and stream its stdout/stderr to the parent.
 * Returns the ChildProcess so the caller can wire signal handlers and
 * await `exit`.
 */
export function spawnStreaming(
  cmd: string,
  args: readonly string[],
  options: SpawnOptions = {},
): ChildProcess {
  return spawn(cmd, args as string[], {
    stdio: 'inherit',
    ...options,
  })
}

/** Wait for a process to exit. Resolves with the exit code. */
export function waitForExit(child: ChildProcess): Promise<number> {
  return new Promise((resolve) => {
    child.on('exit', (code) => {
      resolve(code ?? -1)
    })
  })
}

// ---------------------------------------------------------------------------
// Interactive prompts (DR-only — used by restore passphrase fallback)
// ---------------------------------------------------------------------------

type WritableTty = typeof process.stdout

/** Prompt for a secret — masks input by writing nothing back. */
export function promptSecret(question: string, output: WritableTty = process.stdout): Promise<string> {
  return new Promise((resolve) => {
    output.write(question)

    const muted = new Writable({
      write(_chunk, _enc, cb) {
        cb()
      },
    })

    const rl = readline.createInterface({
      input: process.stdin,
      output: muted,
      terminal: true,
    })

    rl.question('', (answer) => {
      rl.close()
      output.write('\n')
      resolve((answer ?? '').trim())
    })
  })
}

// ---------------------------------------------------------------------------
// Error / exit helpers
// ---------------------------------------------------------------------------

export class RecoveryError extends Error {
  constructor(
    message: string,
    public readonly exitCode: number = 1,
  ) {
    super(message)
    this.name = 'RecoveryError'
  }
}

/**
 * Throw a RecoveryError. Scripts catch it, print the message, and exit
 * with the given code.
 */
export function exitWithError(message: string, code: number = 1): never {
  throw new RecoveryError(message, code)
}

// ---------------------------------------------------------------------------
// Logger (plain stdout — output is meant for humans)
// ---------------------------------------------------------------------------

export function info(message: string): void {
  process.stdout.write(`${message}\n`)
}

export function warn(message: string): void {
  process.stderr.write(`warning: ${message}\n`)
}
