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
import { promises as fsp, createWriteStream } from 'node:fs';
import readline from 'node:readline';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../config/logger.js';
import { getOrbitalHome } from '../config/env.js';
const SYSTEM_ACTOR = { type: 'system', component: 'orchestrator' };
const MAX_LINE_BYTES = 4 * 1024;
const DEFAULT_PUBLISH_RATE = 10;
const DEFAULT_RECENT_BUFFER = 200;
// ---------------------------------------------------------------------------
// Token-bucket
// ---------------------------------------------------------------------------
class TokenBucket {
    capacity;
    refillPerSec;
    nowFn;
    tokens;
    lastRefillMs;
    constructor(capacity, refillPerSec, nowFn) {
        this.capacity = capacity;
        this.refillPerSec = refillPerSec;
        this.nowFn = nowFn;
        this.tokens = capacity;
        this.lastRefillMs = nowFn().getTime();
    }
    /** Try to consume one token. Returns true on success. */
    tryAcquire() {
        this.refill();
        if (this.tokens >= 1) {
            this.tokens -= 1;
            return true;
        }
        return false;
    }
    refill() {
        const nowMs = this.nowFn().getTime();
        const elapsedSec = (nowMs - this.lastRefillMs) / 1000;
        if (elapsedSec <= 0)
            return;
        const add = elapsedSec * this.refillPerSec;
        this.tokens = Math.min(this.capacity, this.tokens + add);
        this.lastRefillMs = nowMs;
    }
}
// ---------------------------------------------------------------------------
// WorkerOutputStream
// ---------------------------------------------------------------------------
export class WorkerOutputStream {
    eventStore;
    workerId;
    taskId;
    recent = [];
    recentCapacity;
    seq = 0;
    bucket;
    logFilePath;
    logStream = null;
    disableLogFile;
    nowFn;
    closed = false;
    constructor(eventStore, options) {
        this.eventStore = eventStore;
        this.workerId = options.workerId;
        this.taskId = options.taskId;
        this.recentCapacity = options.recentBufferSize ?? DEFAULT_RECENT_BUFFER;
        this.disableLogFile = options.disableLogFile ?? false;
        this.nowFn = options.nowFn ?? (() => new Date());
        const rate = options.publishRate ?? DEFAULT_PUBLISH_RATE;
        const burst = options.publishBurst ?? rate;
        this.bucket = new TokenBucket(burst, rate, this.nowFn);
        const dir = options.logDir ?? path.join(resolveOrbitalHome(), 'worker-logs');
        this.logFilePath = path.join(dir, `${options.taskId}.log`);
    }
    // -------------------------------------------------------------------------
    // attach — wire stdout + stderr from a child process
    // -------------------------------------------------------------------------
    attach(stdout, stderr) {
        if (stdout)
            this.attachStream(stdout, 'stdout');
        if (stderr)
            this.attachStream(stderr, 'stderr');
    }
    attachStream(stream, which) {
        const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
        rl.on('line', (line) => {
            // Don't let one rogue line block the loop on event-store write.
            void this.feed(which, line).catch((err) => {
                logger.warn({ err, workerId: this.workerId, stream: which }, 'worker-output-stream: feed failed');
            });
        });
        rl.on('close', () => {
            // Stream ended; nothing to do — close() is called by the caller on exit.
        });
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
    async feed(stream, raw) {
        if (this.closed)
            return;
        const truncated = truncate(raw, MAX_LINE_BYTES);
        this.seq += 1;
        const occurredAt = this.nowFn().toISOString();
        const entry = {
            line_seq: this.seq,
            worker_id: this.workerId,
            task_id: this.taskId,
            stream,
            line: truncated,
            occurred_at: occurredAt,
        };
        // Ring buffer (always)
        this.recent.push(entry);
        if (this.recent.length > this.recentCapacity) {
            this.recent.shift();
        }
        // Log file (always, unless disabled)
        if (!this.disableLogFile) {
            try {
                await this.writeLogLine(stream, occurredAt, truncated);
            }
            catch (err) {
                logger.warn({ err, workerId: this.workerId, logFilePath: this.logFilePath }, 'worker-output-stream: log file write failed');
            }
        }
        // Event publish (rate limited)
        if (!this.bucket.tryAcquire()) {
            return;
        }
        const ev = {
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
        };
        try {
            await this.eventStore.append(ev);
        }
        catch (err) {
            logger.warn({ err, workerId: this.workerId }, 'worker-output-stream: event append failed (line still in log + ring)');
        }
    }
    // -------------------------------------------------------------------------
    // getRecentLines
    // -------------------------------------------------------------------------
    /** Return up to `n` most-recent lines. */
    getRecentLines(n = 200) {
        if (n >= this.recent.length)
            return [...this.recent];
        return this.recent.slice(this.recent.length - n);
    }
    // -------------------------------------------------------------------------
    // close
    // -------------------------------------------------------------------------
    async close() {
        if (this.closed)
            return;
        this.closed = true;
        if (this.logStream) {
            await new Promise((resolve) => {
                this.logStream.end(() => resolve());
            });
            this.logStream = null;
        }
    }
    // -------------------------------------------------------------------------
    // Internal: log file
    // -------------------------------------------------------------------------
    async writeLogLine(stream, occurredAt, line) {
        if (!this.logStream) {
            const dir = path.dirname(this.logFilePath);
            await fsp.mkdir(dir, { recursive: true, mode: 0o755 });
            this.logStream = createWriteStream(this.logFilePath, {
                flags: 'a',
                mode: 0o644,
            });
        }
        const prefix = stream === 'stderr' ? '[E]' : '[O]';
        const out = `${occurredAt} ${prefix} ${line}\n`;
        return new Promise((resolve, reject) => {
            this.logStream.write(out, (err) => {
                if (err)
                    reject(err);
                else
                    resolve();
            });
        });
    }
}
// ---------------------------------------------------------------------------
// Registry — process-wide, keyed by workerId so the tRPC query can look up
// recent lines without holding a direct reference.
// ---------------------------------------------------------------------------
const STREAM_REGISTRY = new Map();
export function registerWorkerOutputStream(stream) {
    STREAM_REGISTRY.set(stream.workerId, stream);
}
export function unregisterWorkerOutputStream(workerId) {
    STREAM_REGISTRY.delete(workerId);
}
export function getWorkerOutputStream(workerId) {
    return STREAM_REGISTRY.get(workerId);
}
/** Test-only: clear all registered streams. */
export function _resetWorkerOutputRegistryForTests() {
    STREAM_REGISTRY.clear();
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function truncate(s, maxBytes) {
    // Fast path: ASCII upper bound.
    if (s.length <= maxBytes / 2)
        return s;
    const buf = Buffer.from(s, 'utf-8');
    if (buf.length <= maxBytes)
        return s;
    // Cut on a UTF-8 boundary by decoding back from the truncated buffer.
    return buf.subarray(0, maxBytes).toString('utf-8');
}
function resolveOrbitalHome() {
    try {
        return getOrbitalHome();
    }
    catch {
        // env hasn't been loaded; use plain $HOME / .orbital fallback.
        const home = process.env.HOME ?? process.env.USERPROFILE ?? os.tmpdir();
        return path.join(home, '.orbital');
    }
}
//# sourceMappingURL=worker-output-stream.js.map