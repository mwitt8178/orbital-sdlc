/**
 * spawn.ts — Spawn a Claude Code worker child process.
 *
 * Per TRD-04 v0.2 §9 and Implementation Plan §6 Task 2C.
 *
 * Responsibilities:
 *  1. Write the capability bundle to {worktree}/.orbital/capability.json (mode 0600).
 *  2. Optionally write the persona brief and bundle skill files into
 *     {worktree}/.orbital/persona.md and {worktree}/.orbital/skills/<slug>.md
 *     (Round5B — real Claude Code worker spawn).
 *  3. node:child_process.spawn the configured CLAUDE_BIN with appropriate args
 *     and env vars.
 *  4. Insert/update the agent_workers row.
 *  5. Emit AgentSpawned via EventStore (never db.insert(events)).
 *  6. Pipe stdout/stderr through a per-worker WorkerOutputStream so the
 *     dashboard can show live output and the audit log captures everything.
 *  7. Surface ENOENT cleanly so callers can distinguish missing-binary from
 *     runtime failures, and surface ANTHROPIC_API_KEY-missing for the real
 *     claude path.
 *
 * Two operating modes:
 *
 *  Mode A (test surrogate; the existing path):
 *    The caller passes `extraArgs: [path-to-fake-worker.mjs]` and
 *    `claudeBinOverride: process.execPath`. We spawn `node fake-worker.mjs`
 *    in `worktreePath`. The fake worker reads ORBITAL_CAPABILITY_PATH and
 *    drives the gateway.
 *
 *  Mode B (real Claude Code; new):
 *    The caller passes `realClaude: { persona, task, brief }` and leaves
 *    extraArgs empty. We pre-flight the binary, build the real `claude`
 *    argument list (`--print --system-prompt ... --allowedTools ...
 *    --session-id <workerId>`), and spawn the real CLI with the task brief
 *    as the prompt. The brief is also written to .orbital/persona.md so the
 *    worker can re-read it via the Read tool, and the skill markdown files
 *    are copied into .orbital/skills/.
 *
 * Both modes use the same worker_id / capability_id / event flow; only the
 * argument list and a few file writes differ.
 */
import { type ChildProcess } from 'node:child_process';
import { type CapabilityBundle } from '@orbital/types';
import type { DB } from '../db/client.js';
import type { EventStore } from '../events/store.js';
import type { Persona } from '../personas/types.js';
import type { BriefTask } from '../personas/brief.js';
import { WorkerOutputStream } from './worker-output-stream.js';
export interface RealClaudeContext {
    /** Persona being spawned. */
    persona: Persona;
    /** Task being assigned (for the prompt body). */
    task: BriefTask;
    /** Pre-rendered persona brief. Written to .orbital/persona.md and used as --system-prompt. */
    brief: string;
    /**
     * Allowed tools for the worker. Comma- or space-separated names matching
     * Claude Code's --allowedTools list. Defaults to a sensible code-editing
     * set: `Bash,Read,Edit,Write,Grep,Glob`.
     */
    allowedTools?: string;
    /**
     * Permission mode passed to claude --permission-mode. Defaults to
     * 'bypassPermissions' for autonomous workers (the capability bundle is
     * the actual gate; the CLI's local prompt would otherwise stall the
     * worker).
     */
    permissionMode?: 'acceptEdits' | 'bypassPermissions' | 'default' | 'dontAsk' | 'plan';
}
export interface SpawnParams {
    taskId: string;
    personaId: string;
    /** Persona display name; used in logs and the brief. */
    personaDisplayName?: string;
    /** Issued capability bundle (signed, ready to use). */
    capability: CapabilityBundle;
    /** Worktree filesystem path. */
    worktreePath: string;
    /** Trace id for this spawn (propagates to AgentSpawned event). */
    traceId: string;
    /** RoutingDecision applied; needed for telemetry. */
    model: string;
    tokenBudget: number;
    /**
     * Optional extra arguments to pass after CLAUDE_BIN. Tests use this to point
     * the spawn at fake-worker.mjs when CLAUDE_BIN=node. Production should leave
     * this empty.
     */
    extraArgs?: string[];
    /**
     * Optional override of CLAUDE_BIN. Defaults to env.CLAUDE_BIN.
     */
    claudeBinOverride?: string;
    /**
     * Optional override of the MCP gateway URL. Defaults to env.ORBITAL_MCP_GATEWAY_URL.
     */
    mcpGatewayUrl?: string;
    /**
     * If true, the spawn function will await child exit before returning. Used by
     * integration tests so the test can assert on completion. Default false.
     */
    awaitExit?: boolean;
    /**
     * Round 6 #3 — Defect iteration: when true, skip WorktreeManager.create().
     * The worktree directory already exists from the prior iteration.
     * The agent branch is already checked out; the worker just picks up from HEAD.
     * The post-task push will use --force-with-lease to update the existing branch.
     * [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
     */
    reuseWorktree?: boolean;
    /**
     * Real Claude Code mode (new in Round5B). When set, we write persona.md,
     * copy skill files, and build the claude argument list from the brief.
     * When unset, we use the legacy extraArgs path.
     */
    realClaude?: RealClaudeContext;
}
export interface SpawnResult {
    /** Worker ID matches bundle.session_id. */
    workerId: string;
    pid: number;
    capabilityFilePath: string;
    /** The ChildProcess handle. Caller may attach further listeners. */
    child: ChildProcess;
    /** Live output stream (rate-limited events + log file). May be null if event store unavailable. */
    outputStream: WorkerOutputStream | null;
    /** Files copied from the bundled skills directory, if realClaude mode used. */
    copiedSkills?: string[];
    /**
     * Resolves when the child exits. Always resolves (never rejects). exitCode
     * is null if killed by signal.
     */
    exited: Promise<{
        exitCode: number | null;
        signal: NodeJS.Signals | null;
    }>;
}
/**
 * Spawn a worker. Returns the live ChildProcess + a promise that resolves on
 * exit. The caller is responsible for tracking the child for monitor/kill.
 *
 * Throws:
 *   - OrbitalError(CLAUDE_BIN_NOT_FOUND) if the binary is missing (ENOENT).
 *   - OrbitalError(STARTUP_ERROR) if realClaude is requested without
 *     ANTHROPIC_API_KEY in env.
 */
export declare function spawn(params: SpawnParams, db: DB, eventStore: EventStore): Promise<SpawnResult>;
//# sourceMappingURL=spawn.d.ts.map