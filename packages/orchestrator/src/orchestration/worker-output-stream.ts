/**
 * worker-output-stream.ts — Capture, rate-limit, persist, and stream live
 * worker stdout/stderr lines.
 *
 * Per Round5B brief — the operator wants to watch a real claude binary work
 * in the dashboard. We get every byte the worker writes, line-buffer it,
 * publish a capped rate to the EventStore (which propagates to the WS hub),
 * and unconditionally append to a per-task log file for full forensics.
 *
 * Architecture:
 *
 *   stdout/stderr -> readline -> WorkerOutputStream.feed
 *                                  |
 *                                  +-- write to log file (always)
 *                                  +-- recent-line ring buffer (UI cursor)
 *                                  +-- token bucket (10 lines/sec, default)
 *                                       +-- EventStore.append(WorkerOutputLine)
 *
 * Backpressure: if the token bucket is empty, the line is recorded in the
 * ring buffer + log file and DROPPED from the WS event stream. The UI gets a
 * line_seq gap and can backfill via `getRecentOutput` on demand.
 */

import { promises as fsp, createWriteStream, type WriteStream } from 'node:fs'
import readline from 'node:readline'
import path from 'node:path'
import os from 'node:os'
import { uuidv7 } from 'uuidv7'
import type { Readable } from 'node:stream'
import type { Actor, EventInput } from '@orbital/types'
import type { EventStore } from '../events/store.js'
import { logger } from '../config/logger.js'
import { getOrbitalHome } from '../config/env.js'

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OutputStream = 'stdout' | 'stderr'

export interface WorkerOutputLine {
  /** Monotonic seq within this worker. Starts at 1. */
  line_seq: number
  worker_id: string
  task_id: string
  stream: OutputStream
  /** UTF-8 line, no trailing \n, truncated at 4 KB. */
  line: string
  occurred_at: string
}

export interface WorkerOutputStreamOptions {
  workerId: string
  taskId: string
  /** Tokens per second for event publication. Default 10. */
  publishRate?: number
  /** Burst size — how many lines can publish back-to-back before throttling. Default = publishRate. */
  publishBurst?: number
  /** Ring buffer size for getRecentLines. Default 200. */
  recentBufferSize?: number
  /** Override log file directory. Default ~/.orbital/worker-logs. */
  logDir?: string
  /** Disable log file writes (tests). */
  disableLogFile?: boolean
  /** Override now() for tests. */
  nowFn?: () => Date
}

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }
const MAX_LINE_BYTES = 4 * 1024
const DEFAULT_PUBLISH_RATE = 10
const DEFAULT_RECENT_BUFFER = 200

// ---------------------------------------------------------------------------
// Token-bucket
// ---------------------------------------------------------------------------

class TokenBucket {
  private tokens: number
  private lastRefillMs: number

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    private readonly nowFn: () => Date,
  ) {
    this.tokens = capacity
    this.lastRefillMs = nowFn().getTime()
  }

  /** Try to consume one token. Returns true on success. */
  tryAcquire(): boolean {
    this.refill()
    if (this.tokens >= 1) {
      this.tokens -= 1
      return true
    }
    return false
  }

  private refill(): void {
    const nowMs = this.nowFn().getTime()
    const elapsedSec = (nowMs - this.lastRefillMs) / 1000
    if (elapsedSec <= 0) return
    const add = elapsedSec * this.refillPerSec
    this.tokens = Math.min(this.capacity, this.tokens + add)
    this.lastRefillMs = nowMs
  }
}

// ---------------------------------------------------------------------------
// WorkerOutputStream
// ---------------------------------------------------------------------------

export class WorkerOutputStream {
  readonly workerId: string
  readonly taskId: string
  private readonly recent: WorkerOutputLine[] = []
  private readonly recentCapacity: number
  private seq = 0
  private readonly bucket: TokenBucket
  private readonly logFilePath: string
  private logStream: WriteStream | null = null
  private readonly disableLogFile: boolean
  private readonly nowFn: () => Date
  private closed = false

  constructor(
    private readonly eventStore: EventStore,
    options: WorkerOutputStreamOptions,
  ) {
    this.workerId = options.workerId
    this.taskId = options.taskId
    this.recentCapacity = options.recentBufferSize ?? DEFAULT_RECENT_BUFFER
    this.disableLogFile = options.disableLogFile ?? false
    this.nowFn = options.nowFn ?? (() => new Date())

    const rate = options.publishRate ?? DEFAULT_PUBLISH_RATE
    const burst = options.publishBurst ?? rate
    this.bucket = new TokenBucket(burst, rate, this.nowFn)

    const dir = options.logDir ?? path.join(resolveOrbitalHome(), 'worker-logs')
    this.logFilePath = path.join(dir, `${options.taskId}.log`)
  }

  // -------------------------------------------------------------------------
  // attach — wire stdout + stderr from a child process
  // -------------------------------------------------------------------------

  attach(stdout: Readable | null | undefined, stderr: Readable | null | undefined): void {
    if (stdout) this.attachStream(stdout, 'stdout')
    if (stderr) this.attachStream(stderr, 'stderr')
  }

  private attachStream(stream: Readable, which: OutputStream): void {
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity })
    rl.on('line', (line) => {
      // Don't let one rogue line block the loop on event-store write.
      void this.feed(which, line).catch((err: unknown) => {
        logger.warn(
          { err, workerId: this.workerId, stream: which },
          'worker-output-stream: feed failed',
        )
      })
    })
    rl.on('close', () => {
      // Stream ended; nothing to do — close() is called by the caller on exit.
    })
  }

  // -------------------------------------------------------------------------
  // feed — accept a line from any source
  // -------------------------------------------------------------------------

  /**
   * Record a single line. Always written to the log file + ring buffer. Only
   * published as an event if the token bucket allows.
   *
   * Visible for unit tests so the rate-limit and persistence behavior can be
   * exercised directly without spawning a child.
   */
  async feed(stream: OutputStream, raw: string): Promise<void> {
    if (this.closed) return

    const truncated = truncate(raw, MAX_LINE_BYTES)
    this.seq += 1
    const occurredAt = this.nowFn().toISOString()
    const entry: WorkerOutputLine = {
      line_seq: this.seq,
      worker_id: this.workerId,
      task_id: this.taskId,
      stream,
      line: truncated,
      occurred_at: occurredAt,
    }

    // Ring buffer (always)
    this.recent.push(entry)
    if (this.recent.length > this.recentCapacity) {
      this.recent.shift()
    }

    // Log file (always, unless disabled)
    if (!this.disableLogFile) {
      try {
        await this.writeLogLine(stream, occurredAt, truncated)
      } catch (err) {
        logger.warn(
          { err, workerId: this.workerId, logFilePath: this.logFilePath },
          'worker-output-stream: log file write failed',
        )
      }
    }

    // Event publish (rate limited)
    if (!this.bucket.tryAcquire()) {
      return
    }

    const ev: EventInput = {
      aggregate_id: this.workerId,
      aggregate_type: 'orchestration',
      event_type: 'WorkerOutputLine',
      payload: {
        worker_id: this.workerId,
        task_id: this.taskId,
        stream,
        line: truncated,
        line_seq: entry.line_seq,
      },
      actor: SYSTEM_ACTOR,
      trace_id: this.workerId,
      occurred_at: occurredAt,
      schema_version: 1,
    }
    try {
      await this.eventStore.append(ev)
    } catch (err) {
      logger.warn(
        { err, workerId: this.workerId },
        'worker-output-stream: event append failed (line still in log + ring)',
      )
    }
  }

  // -------------------------------------------------------------------------
  // getRecentLines
  // -------------------------------------------------------------------------

  /** Return up to `n` most-recent lines. */
  getRecentLines(n = 200): WorkerOutputLine[] {
    if (n >= this.recent.length) return [...this.recent]
    return this.recent.slice(this.recent.length - n)
  }

  // -------------------------------------------------------------------------
  // close
  // -------------------------------------------------------------------------

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    if (this.logStream) {
      await new Promise<void>((resolve) => {
        this.logStream!.end(() => resolve())
      })
      this.logStream = null
    }
  }

  // -------------------------------------------------------------------------
  // Internal: log file
  // -------------------------------------------------------------------------

  private async writeLogLine(
    stream: OutputStream,
    occurredAt: string,
    line: string,
  ): Promise<void> {
    if (!this.logStream) {
      const dir = path.dirname(this.logFilePath)
      await fsp.mkdir(dir, { recursive: true, mode: 0o755 })
      this.logStream = createWriteStream(this.logFilePath, {
        flags: 'a',
        mode: 0o644,
      })
    }
    const prefix = stream === 'stderr' ? '[E]' : '[O]'
    const out = `${occurredAt} ${prefix} ${line}\n`
    return new Promise<void>((resolve, reject) => {
      this.logStream!.write(out, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
  }
}

// ---------------------------------------------------------------------------
// Registry — process-wide, keyed by workerId so the tRPC query can look up
// recent lines without holding a direct reference.
// ---------------------------------------------------------------------------

const STREAM_REGISTRY = new Map<string, WorkerOutputStream>()

export function registerWorkerOutputStream(stream: WorkerOutputStream): void {
  STREAM_REGISTRY.set(stream.workerId, stream)
}

export function unregisterWorkerOutputStream(workerId: string): void {
  STREAM_REGISTRY.delete(workerId)
}

export function getWorkerOutputStream(
  workerId: string,
): WorkerOutputStream | undefined {
  return STREAM_REGISTRY.get(workerId)
}

/** Test-only: clear all registered streams. */
export function _resetWorkerOutputRegistryForTests(): void {
  STREAM_REGISTRY.clear()
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function truncate(s: string, maxBytes: number): string {
  // Fast path: ASCII upper bound.
  if (s.length <= maxBytes / 2) return s
  const buf = Buffer.from(s, 'utf-8')
  if (buf.length <= maxBytes) return s
  // Cut on a UTF-8 boundary by decoding back from the truncated buffer.
  return buf.subarray(0, maxBytes).toString('utf-8')
}

function resolveOrbitalHome(): string {
  try {
    return getOrbitalHome()
  } catch {
    // env hasn't been loaded; use plain $HOME / .orbital fallback.
    const home = process.env.HOME ?? process.env.USERPROFILE ?? os.tmpdir()
    return path.join(home, '.orbital')
  }
}
