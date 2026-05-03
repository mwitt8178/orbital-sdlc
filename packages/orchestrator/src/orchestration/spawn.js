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
import { spawn as childSpawn, spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { eq } from 'drizzle-orm';
import { OrbitalError } from '@orbital/types';
import { agentWorkers } from '../db/schema/worker-tables.js';
import { tasks } from '../db/schema/orchestration.js';
import { logger } from '../config/logger.js';
import { loadEnv } from '../config/env.js';
// Round 7-02 — hub worker dual-write: register worker in hub when configured.
// [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
import { getHubClient } from '../hub-client/index.js';
import { bundleSkillsForWorker } from '../personas/skill-loader.js';
import { WorkerOutputStream, registerWorkerOutputStream, unregisterWorkerOutputStream, } from './worker-output-stream.js';
import { CAPABILITY_FILE_RELATIVE_PATH, ORCHESTRATION_ERROR_CODES } from './types.js';
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
const SYSTEM_ACTOR = { type: 'system', component: 'orchestrator' };
const DEFAULT_ALLOWED_TOOLS = 'Bash,Read,Edit,Write,Grep,Glob';
/**
 * Spawn a worker. Returns the live ChildProcess + a promise that resolves on
 * exit. The caller is responsible for tracking the child for monitor/kill.
 *
 * Throws:
 *   - OrbitalError(CLAUDE_BIN_NOT_FOUND) if the binary is missing (ENOENT).
 *   - OrbitalError(STARTUP_ERROR) if realClaude is requested without
 *     ANTHROPIC_API_KEY in env.
 */
export async function spawn(params, db, eventStore) {
    const env = loadEnv();
    const claudeBin = params.claudeBinOverride ?? env.CLAUDE_BIN;
    const mcpGatewayUrl = params.mcpGatewayUrl ?? env.ORBITAL_MCP_GATEWAY_URL;
    const workerId = params.capability.session_id;
    // -------------------------------------------------------------------------
    // Pre-flight checks (real-claude mode)
    // -------------------------------------------------------------------------
    if (params.realClaude) {
        if (!env.ANTHROPIC_API_KEY) {
            throw new OrbitalError(ORCHESTRATION_ERROR_CODES.AUTH_INVALID_CAPABILITY, 'STARTUP_ERROR: ANTHROPIC_API_KEY is required to spawn a real Claude Code worker. ' +
                'Set ANTHROPIC_API_KEY in your env or use the test surrogate path.', { reason: 'ANTHROPIC_API_KEY missing' });
        }
    }
    // -------------------------------------------------------------------------
    // Step 1: write capability bundle file (mode 0600)
    // -------------------------------------------------------------------------
    const capabilityFilePath = path.join(params.worktreePath, CAPABILITY_FILE_RELATIVE_PATH);
    const capabilityDir = path.dirname(capabilityFilePath);
    await fs.mkdir(capabilityDir, { recursive: true, mode: 0o700 });
    await fs.writeFile(capabilityFilePath, JSON.stringify(params.capability, null, 2), {
        mode: 0o600,
    });
    // -------------------------------------------------------------------------
    // Step 1b (real-claude): write persona.md + bundle skills
    // -------------------------------------------------------------------------
    let copiedSkills;
    if (params.realClaude) {
        const personaMdPath = path.join(params.worktreePath, '.orbital', 'persona.md');
        await fs.writeFile(personaMdPath, params.realClaude.brief, { mode: 0o644 });
        const bundleResult = await bundleSkillsForWorker(params.realClaude.persona, params.worktreePath);
        copiedSkills = bundleResult.copied;
    }
    // -------------------------------------------------------------------------
    // Step 1c: create agent branch in worktree (before spawning worker)
    // Branch name: agent/<task-id> — matches the convention the post-task hook
    // and PROrchestrator use to push + open the PR.
    // This is best-effort: if the worktree is not a git repo (e.g. test fixtures
    // without a real git init), we log a warning and continue rather than failing
    // the spawn. The push step in post-task will fail clearly if the branch
    // was never created.
    // [Engineer-Sr · Sonnet · run-round6-01-pr-loop]
    //
    // Round 6 #3: when reuseWorktree=true, the branch already exists from a
    // prior iteration — skip checkout -B so we don't reset the branch pointer.
    // The existing HEAD is exactly where the author left off after the previous
    // iteration. The worker will commit on top of it; push uses --force-with-lease.
    // [Engineer-Sr · Sonnet · run-round6-03-defect-iteration]
    // -------------------------------------------------------------------------
    const agentBranchName = `agent/${params.taskId}`;
    if (!params.reuseWorktree) {
        try {
            const branchResult = spawnSync('git', ['checkout', '-B', agentBranchName], {
                cwd: params.worktreePath,
                stdio: ['pipe', 'pipe', 'pipe'],
                encoding: 'utf-8',
            });
            if (branchResult.status !== 0) {
                const stderr = branchResult.stderr ?? '';
                logger.warn({ taskId: params.taskId, branchName: agentBranchName, stderr: stderr.slice(0, 200) }, 'spawn: git checkout -B for agent branch failed; worker will run on current branch');
            }
            else {
                logger.debug({ taskId: params.taskId, branchName: agentBranchName }, 'spawn: agent branch created');
            }
        }
        catch (err) {
            logger.warn({ err, taskId: params.taskId, branchName: agentBranchName }, 'spawn: git branch creation threw; continuing without branch switch');
        }
    }
    else {
        logger.debug({ taskId: params.taskId, branchName: agentBranchName }, 'spawn: reuseWorktree=true — skipping git checkout -B (defect iteration)');
    }
    // -------------------------------------------------------------------------
    // Step 2: prepare spawn env
    // -------------------------------------------------------------------------
    const spawnEnv = {
        ...process.env,
        ORBITAL_CAPABILITY_PATH: capabilityFilePath,
        ORBITAL_TASK_ID: params.taskId,
        ORBITAL_MCP_GATEWAY_URL: mcpGatewayUrl,
        ORBITAL_WORKER_ID: workerId,
        ORBITAL_TRACE_ID: params.traceId,
        ORBITAL_MODEL: params.model,
        ORBITAL_TOKEN_BUDGET: String(params.tokenBudget),
    };
    if (env.ANTHROPIC_API_KEY) {
        spawnEnv['ANTHROPIC_API_KEY'] = env.ANTHROPIC_API_KEY;
    }
    // -------------------------------------------------------------------------
    // Step 3: build argv
    // -------------------------------------------------------------------------
    let args;
    if (params.realClaude) {
        args = buildRealClaudeArgs(params, params.realClaude, workerId);
    }
    else {
        args = params.extraArgs ?? [];
    }
    // -------------------------------------------------------------------------
    // Step 4: spawn child process
    // -------------------------------------------------------------------------
    let child;
    try {
        child = childSpawn(claudeBin, args, {
            cwd: params.worktreePath,
            env: spawnEnv,
            stdio: ['ignore', 'pipe', 'pipe'],
            detached: false,
        });
    }
    catch (err) {
        if (isENOENT(err)) {
            // Best-effort cleanup of the bundle file on failure.
            await fs.unlink(capabilityFilePath).catch(() => undefined);
            throw new OrbitalError(ORCHESTRATION_ERROR_CODES.CLAUDE_BIN_NOT_FOUND, formatNotFoundMessage(claudeBin), { claude_bin: claudeBin, code: 'ENOENT' });
        }
        await fs.unlink(capabilityFilePath).catch(() => undefined);
        throw err;
    }
    // Detect async ENOENT — on Linux/Darwin, child_process.spawn returns a
    // ChildProcess even for a non-existent binary; the ENOENT surfaces via the
    // 'error' event a few microseconds later. We wait briefly for either
    // 'spawn' (success) or 'error' (failure).
    const earlyError = await waitForEarlySpawnSignal(child);
    if (earlyError) {
        await fs.unlink(capabilityFilePath).catch(() => undefined);
        if (isENOENT(earlyError)) {
            throw new OrbitalError(ORCHESTRATION_ERROR_CODES.CLAUDE_BIN_NOT_FOUND, formatNotFoundMessage(claudeBin), { claude_bin: claudeBin, code: 'ENOENT' });
        }
        throw new OrbitalError(ORCHESTRATION_ERROR_CODES.INTERNAL_SPAWN_ABORTED, `child process spawn failed: ${earlyError.message}`, { claude_bin: claudeBin });
    }
    const exited = new Promise((resolve) => {
        child.on('error', (err) => {
            logger.warn({ err, taskId: params.taskId }, 'spawn: child error event after spawn');
        });
        child.on('exit', (code, signal) => {
            resolve({ exitCode: code, signal });
        });
    });
    // -------------------------------------------------------------------------
    // Step 4b: wire up live output streaming
    // -------------------------------------------------------------------------
    let outputStream = null;
    try {
        outputStream = new WorkerOutputStream(eventStore, {
            workerId,
            taskId: params.taskId,
        });
        outputStream.attach(child.stdout, child.stderr);
        registerWorkerOutputStream(outputStream);
        child.once('exit', () => {
            // Best-effort cleanup; the registry entry can outlive the child briefly
            // so the UI's getRecentOutput query still works after exit.
            void outputStream.close().catch(() => undefined);
            // Defer unregister so a final UI query can pick up the buffer.
            setTimeout(() => unregisterWorkerOutputStream(workerId), 30_000).unref?.();
        });
    }
    catch (err) {
        logger.warn({ err, workerId, taskId: params.taskId }, 'spawn: failed to attach WorkerOutputStream; falling back to debug-only logging');
        outputStream = null;
        // Fall back to the original debug-level log piping.
        child.stdout?.on('data', (chunk) => {
            logger.debug({ taskId: params.taskId, workerId, stream: 'stdout', text: chunk.toString().trimEnd() }, 'worker stdout');
        });
        child.stderr?.on('data', (chunk) => {
            logger.debug({ taskId: params.taskId, workerId, stream: 'stderr', text: chunk.toString().trimEnd() }, 'worker stderr');
        });
    }
    const pid = child.pid ?? 0;
    if (pid === 0) {
        // pid is null only if spawn failed synchronously; we already handled the
        // common cases above, but bail safely.
        await fs.unlink(capabilityFilePath).catch(() => undefined);
        throw new OrbitalError(ORCHESTRATION_ERROR_CODES.INTERNAL_SPAWN_ABORTED, 'spawn returned no pid', { claude_bin: claudeBin });
    }
    // -------------------------------------------------------------------------
    // Step 5: insert/update agent_workers row
    // -------------------------------------------------------------------------
    // Idempotency: if a row already exists for this workerId we update pid/status.
    const existing = await db
        .select()
        .from(agentWorkers)
        .where(eq(agentWorkers.workerId, workerId))
        .limit(1);
    if (existing[0]) {
        await db
            .update(agentWorkers)
            .set({
            pid,
            status: 'connecting',
            startedAt: new Date(),
            taskId: params.taskId,
            capabilityId: params.capability.capability_id,
        })
            .where(eq(agentWorkers.workerId, workerId));
    }
    else {
        await db.insert(agentWorkers).values({
            workerId,
            personaId: params.personaId,
            sessionId: workerId,
            taskId: params.taskId,
            status: 'connecting',
            startedAt: new Date(),
            capabilityId: params.capability.capability_id,
            pid,
        });
    }
    // Round 7-02 — hub dual-write: register worker in hub when configured.
    // Hub provides cross-operator worker visibility (Ricky sees Matt's workers).
    // Best-effort: local write is authoritative; hub write failure is logged and ignored.
    // [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
    const hubClient = getHubClient();
    if (hubClient !== null) {
        const env = loadEnv();
        const hubReg = await hubClient.workers.register({
            worker_id: workerId,
            task_id: params.taskId,
            install_id: params.capability.session_id,
            pid,
            state: 'connecting',
            started_at: new Date().toISOString(),
            tenant_id: env.ORBITAL_HUB_TENANT_ID,
        });
        if (!hubReg.ok) {
            logger.warn({ workerId, hubError: hubReg.message }, 'spawn: hub worker registration failed (non-fatal; local write succeeded)');
        }
    }
    // -------------------------------------------------------------------------
    // Step 6: link the worker to the task row (current_worker_id)
    // -------------------------------------------------------------------------
    // We do this even though the task may not be in 'in_progress' yet; the
    // scheduler is responsible for the state transition. We just stamp the link.
    await db
        .update(tasks)
        .set({
        currentWorkerId: workerId,
        currentCapabilityId: params.capability.capability_id,
    })
        .where(eq(tasks.taskId, params.taskId));
    // -------------------------------------------------------------------------
    // Step 7: emit AgentSpawned event via EventStore
    // -------------------------------------------------------------------------
    const ev = {
        aggregate_id: workerId,
        aggregate_type: 'orchestration',
        event_type: 'AgentSpawned',
        payload: {
            worker_id: workerId,
            task_id: params.taskId,
            persona_id: params.personaId,
            capability_id: params.capability.capability_id,
            pid,
            claude_bin: claudeBin,
            worktree_path: params.worktreePath,
            model: params.model,
            token_budget: params.tokenBudget,
            real_claude: params.realClaude !== undefined,
            copied_skills: copiedSkills ?? [],
        },
        actor: SYSTEM_ACTOR,
        capability_id: params.capability.capability_id,
        trace_id: params.traceId,
        occurred_at: new Date().toISOString(),
        schema_version: 1,
    };
    await eventStore.append(ev);
    // Round 6 #10: emit WorkerLifecyclePhase 'briefing' immediately after spawn.
    // [Engineer-Sr · Sonnet · run-round6-10-inspection]
    await eventStore.append({
        aggregate_id: workerId,
        aggregate_type: 'orchestration',
        event_type: 'WorkerLifecyclePhase',
        payload: {
            worker_id: workerId,
            phase: 'briefing',
            occurred_at: new Date().toISOString(),
        },
        actor: SYSTEM_ACTOR,
        capability_id: params.capability.capability_id,
        trace_id: params.traceId,
        occurred_at: new Date().toISOString(),
        schema_version: 1,
    });
    // Emit 'running' once the process has confirmed spawn (pid is valid).
    await eventStore.append({
        aggregate_id: workerId,
        aggregate_type: 'orchestration',
        event_type: 'WorkerLifecyclePhase',
        payload: {
            worker_id: workerId,
            phase: 'running',
            occurred_at: new Date().toISOString(),
        },
        actor: SYSTEM_ACTOR,
        capability_id: params.capability.capability_id,
        trace_id: params.traceId,
        occurred_at: new Date().toISOString(),
        schema_version: 1,
    });
    // Emit 'terminated' when the child exits.
    // This is best-effort; the process exit event may arrive after caller cleanup.
    void exited.then(async () => {
        try {
            await eventStore.append({
                aggregate_id: workerId,
                aggregate_type: 'orchestration',
                event_type: 'WorkerLifecyclePhase',
                payload: {
                    worker_id: workerId,
                    phase: 'terminated',
                    occurred_at: new Date().toISOString(),
                },
                actor: SYSTEM_ACTOR,
                capability_id: params.capability.capability_id,
                trace_id: params.traceId,
                occurred_at: new Date().toISOString(),
                schema_version: 1,
            });
        }
        catch (err) {
            logger.warn({ err, workerId }, 'spawn: failed to emit WorkerLifecyclePhase(terminated)');
        }
    });
    logger.info({
        taskId: params.taskId,
        workerId,
        pid,
        claudeBin,
        realClaude: params.realClaude !== undefined,
        copiedSkillCount: copiedSkills?.length ?? 0,
    }, 'spawn: worker started');
    if (params.awaitExit) {
        await exited;
    }
    return { workerId, pid, capabilityFilePath, child, outputStream, copiedSkills, exited };
}
// ---------------------------------------------------------------------------
// Real-claude argv builder
// ---------------------------------------------------------------------------
/**
 * Build the `claude` CLI argument list for a real-claude spawn.
 *
 * Reference: `claude --help` output (Claude Code v2.x).
 *
 * Flags chosen:
 *   --print                       one-shot, no interactive REPL (worker exits after task.complete)
 *   --output-format stream-json   structured stream we can parse for progress
 *   --include-partial-messages    so the UI sees thinking-in-flight, not silence
 *   --system-prompt <brief>       persona role + scope summary
 *   --allowedTools Bash,Read,...  what the agent may call locally
 *   --permission-mode bypassPermissions
 *                                 the orbital capability bundle is the real gate;
 *                                 the CLI's interactive prompt would otherwise stall
 *   --session-id <workerId>       ties claude's session to the orbital worker_id
 *   --model <model>               from RoutingDecision (alias or full model id)
 *   <prompt>                      the task description as the positional prompt
 */
function buildRealClaudeArgs(params, ctx, workerId) {
    const allowedTools = ctx.allowedTools ?? DEFAULT_ALLOWED_TOOLS;
    const permissionMode = ctx.permissionMode ?? 'bypassPermissions';
    // Build the prompt body. The system prompt carries the persona + scope; the
    // positional prompt is the actual task description and acceptance criteria.
    const promptBody = buildPromptBody(ctx.task);
    return [
        '--print',
        '--output-format',
        'stream-json',
        '--input-format',
        'text',
        '--include-partial-messages',
        '--verbose',
        '--system-prompt',
        ctx.brief,
        '--allowedTools',
        allowedTools,
        '--permission-mode',
        permissionMode,
        '--session-id',
        workerId,
        '--model',
        resolveModelArg(params.model),
        promptBody,
    ];
}
/**
 * Construct the positional prompt the worker sees. Includes the task title,
 * description, and acceptance criteria — the same content the brief already
 * has in its task section, restated here so the model receives it both as
 * system and user input. This matches what humans see when they paste a
 * ticket into Claude Code.
 */
function buildPromptBody(task) {
    const acLines = task.acceptance_criteria.length > 0
        ? task.acceptance_criteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')
        : '(no explicit acceptance criteria)';
    return [
        `# Task: ${task.title}`,
        '',
        task.description,
        '',
        '## Acceptance criteria',
        '',
        acLines,
        '',
        '## How to finish',
        '',
        'When you have completed the work, call `task.complete` via the MCP gateway',
        'with a summary of what you did and the list of files you changed. If you',
        'hit a blocker, call `task.request_help` instead.',
    ].join('\n');
}
/**
 * The Claude Code CLI accepts either an alias ('opus', 'sonnet', 'haiku') or a
 * full model id. Routing produces full ids like 'claude-sonnet-4-6'; pass them
 * through as-is — the CLI accepts both.
 */
function resolveModelArg(model) {
    return model;
}
// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function isENOENT(err) {
    if (err instanceof Error) {
        const e = err;
        return e.code === 'ENOENT';
    }
    if (typeof err === 'object' && err !== null && 'code' in err) {
        return err.code === 'ENOENT';
    }
    return false;
}
function formatNotFoundMessage(claudeBin) {
    return (`INTEGRATION_CLAUDE_NOT_FOUND: Claude CLI binary not found: ${claudeBin}. ` +
        `Install with: npm i -g @anthropic-ai/claude-code OR set CLAUDE_BIN=/path/to/claude. ` +
        `Verify with: which $CLAUDE_BIN && $CLAUDE_BIN --version`);
}
/**
 * Wait briefly for either the 'spawn' event (success) or 'error' event
 * (failure, e.g. ENOENT). Returns the error if one fires; null on success.
 *
 * On Node 22+, ChildProcess emits 'spawn' once the syscall succeeds. ENOENT
 * surfaces via 'error' on the next microtask after spawn() returns.
 */
function waitForEarlySpawnSignal(child) {
    return new Promise((resolve) => {
        let settled = false;
        const onSpawn = () => {
            if (settled)
                return;
            settled = true;
            child.off('error', onError);
            resolve(null);
        };
        const onError = (err) => {
            if (settled)
                return;
            settled = true;
            child.off('spawn', onSpawn);
            resolve(err);
        };
        child.once('spawn', onSpawn);
        child.once('error', onError);
        // Fallback: if neither fires within 100ms, assume success.
        setTimeout(() => {
            if (settled)
                return;
            settled = true;
            child.off('spawn', onSpawn);
            child.off('error', onError);
            resolve(null);
        }, 100).unref?.();
    });
}
//# sourceMappingURL=spawn.js.map