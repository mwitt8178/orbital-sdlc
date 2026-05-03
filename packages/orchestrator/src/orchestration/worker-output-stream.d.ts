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
import type { Readable } from 'node:stream';
import type { EventStore } from '../events/store.js';
export type OutputStream = 'stdout' | 'stderr';
export interface WorkerOutputLine {
    /** Monotonic seq within this worker. Starts at 1. */
    line_seq: number;
    worker_id: string;
    task_id: string;
    stream: OutputStream;
    /** UTF-8 line, no trailing \n, truncated at 4 KB. */
    line: string;
    occurred_at: string;
}
export interface WorkerOutputStreamOptions {
    workerId: string;
    taskId: string;
    /** Tokens per second for event publication. Default 10. */
    publishRate?: number;
    /** Burst size — how many lines can publish back-to-back before throttling. Default = publishRate. */
    publishBurst?: number;
    /** Ring buffer size for getRecentLines. Default 200. */
    recentBufferSize?: number;
    /** Override log file directory. Default ~/.orbital/worker-logs. */
    logDir?: string;
    /** Disable log file writes (tests). */
    disableLogFile?: boolean;
    /** Override now() for tests. */
    nowFn?: () => Date;
}
export declare class WorkerOutputStream {
    private readonly eventStore;
    readonly workerId: string;
    readonly taskId: string;
    private readonly recent;
    private readonly recentCapacity;
    private seq;
    private readonly bucket;
    private readonly logFilePath;
    private logStream;
    private readonly disableLogFile;
    private readonly nowFn;
    private closed;
    constructor(eventStore: EventStore, options: WorkerOutputStreamOptions);
    attach(stdout: Readable | null | undefined, stderr: Readable | null | undefined): void;
    private attachStream;
    /**
     * Record a single line. Always written to the log file + ring buffer. Only
     * published as an event if the token bucket allows.
     *
     * Visible for unit tests so the rate-limit and persistence behavior can be
     * exercised directly without spawning a child.
     */
    feed(stream: OutputStream, raw: string): Promise<void>;
    /** Return up to `n` most-recent lines. */
    getRecentLines(n?: number): WorkerOutputLine[];
    close(): Promise<void>;
    private writeLogLine;
}
export declare function registerWorkerOutputStream(stream: WorkerOutputStream): void;
export declare function unregisterWorkerOutputStream(workerId: string): void;
export declare function getWorkerOutputStream(workerId: string): WorkerOutputStream | undefined;
/** Test-only: clear all registered streams. */
export declare function _resetWorkerOutputRegistryForTests(): void;
//# sourceMappingURL=worker-output-stream.d.ts.map