/**
 * buildBrief — constructs the system-prompt string for a persona at spawn time.
 *
 * Per TRD-03 §6.6 and Implementation Plan §6 Task 2A done-criteria:
 * - Contains persona role
 * - Contains task title, description, acceptance_criteria summary
 * - Contains capability scope summary
 * - Returns a non-empty string
 *
 * Format: ~1-3 KB structured markdown prompt.
 *
 * Round 6 Task #4: brief now includes top-k project memory entries when
 * a db + eventStore + projectId are provided via MemoryBriefContext.
 *
 * Round 6 Task #8: when a routingEngine is provided in BriefExtensions and the
 * persona has a risk_class+estimate, routeModel() is called and the resolved
 * provider+model badge is appended to the header so the worker knows which
 * provider routed it.
 */
import { injectMemoryIntoBrief, } from '../memory/brief-injector.js';
// ---------------------------------------------------------------------------
// buildBrief
// ---------------------------------------------------------------------------
/**
 * Build a structured system prompt for a persona worker spawn.
 *
 * Async when memoryContext is provided (retrieves project memory entries).
 * Sync-compatible via buildBriefSync for callers that cannot await.
 *
 * [Engineer-Sr · Sonnet · run-round6-04-project-memory]
 *
 * @param persona     The persona being spawned (from PersonaLoader.get())
 * @param task        The task being assigned
 * @param capability  The capability bundle issued for this spawn
 * @param extensions  Optional extensions: history, vision, memory
 * @returns           A structured markdown string suitable as a system prompt
 */
export async function buildBrief(persona, task, capability, extensions = {}) {
    // Memory injection (async — runs before building sections)
    // [Engineer-Sr · Sonnet · run-memory-prompt-assembly]
    let memoryInjection = null;
    if (extensions.memoryContext) {
        const { db, eventStore, projectId, k = 8, tenantId, personaSlug } = extensions.memoryContext;
        memoryInjection = await injectMemoryIntoBrief(db, eventStore, projectId, task.task_id, {
            title: task.title,
            description: task.description,
        }, k, { tenantId, personaSlug });
    }
    // Round 6 #8 — routeModel: resolve provider+model badge for this spawn.
    let modelBadge = '';
    if (extensions.routingContext) {
        const { routingEngine, estimate, authorProvider, authorModel, traceId } = extensions.routingContext;
        try {
            const routeResult = await routingEngine.routeModel({
                persona: persona.slug ?? persona.displayName.toLowerCase().replace(/\s+/g, '-'),
                estimate,
                authorProvider,
                authorModel,
                traceId,
            });
            modelBadge = `\n\n> **Model**: ${routeResult.model} via ${routeResult.provider}${routeResult.sodApplied ? ' (SoD override)' : ''}`;
        }
        catch {
            // Non-fatal: routing metadata is informational in the brief.
        }
    }
    const sections = [];
    // ---------------------------------------------------------------------------
    // Section 1: Role
    // ---------------------------------------------------------------------------
    sections.push(`# Role: ${persona.displayName}${modelBadge}

${persona.roleBriefMd}`);
    // ---------------------------------------------------------------------------
    // Section 2: Task
    // ---------------------------------------------------------------------------
    const acLines = task.acceptance_criteria.length > 0
        ? task.acceptance_criteria
            .map((ac, i) => `${i + 1}. ${ac}`)
            .join('\n')
        : '(No acceptance criteria specified)';
    sections.push(`# Task

**Task ID:** ${task.task_id}
**Title:** ${task.title}
**Risk Class:** ${task.risk_class ?? 'standard'}

## Description

${task.description}

## Acceptance Criteria

${acLines}`);
    // ---------------------------------------------------------------------------
    // Section 3: Capability Scope Summary
    // ---------------------------------------------------------------------------
    const scopeParts = [];
    const scopes = capability.scopes;
    if (scopes.files_read && scopes.files_read.length > 0) {
        scopeParts.push(`**Files you may READ:** ${scopes.files_read.join(', ')}`);
    }
    if (scopes.files_write && scopes.files_write.length > 0) {
        scopeParts.push(`**Files you may WRITE:** ${scopes.files_write.join(', ')}`);
    }
    if (scopes.channel_post && scopes.channel_post.length > 0) {
        scopeParts.push(`**Channels you may POST to:** ${scopes.channel_post.join(', ')}`);
    }
    if (scopes.channel_read && scopes.channel_read.length > 0) {
        scopeParts.push(`**Channels you may READ:** ${scopes.channel_read.join(', ')}`);
    }
    if (scopes.board_mutate && scopes.board_mutate.length > 0) {
        scopeParts.push(`**Board fields you may MUTATE:** ${scopes.board_mutate.join(', ')}`);
    }
    if (scopes.secrets && scopes.secrets.length > 0) {
        scopeParts.push(`**Secrets you may ACCESS:** ${scopes.secrets.join(', ')}`);
    }
    if (scopes.network_egress && scopes.network_egress.length > 0) {
        scopeParts.push(`**Network egress allowed to:** ${scopes.network_egress.join(', ')}`);
    }
    if (scopes.git_commit && scopes.git_commit.length > 0) {
        const gitSummary = scopes.git_commit
            .map((g) => `branch \`${g.branch}\` / paths \`${g.paths.join(', ')}\``)
            .join('; ');
        scopeParts.push(`**Git commits allowed:** ${gitSummary}`);
    }
    const scopeBody = scopeParts.length > 0
        ? scopeParts.join('\n')
        : '(No explicit scopes — all tool calls will be denied)';
    sections.push(`# Capability Scope

Your capability bundle grants you the following permissions. The MCP gateway
enforces these strictly — any tool call outside this scope will be denied.

${scopeBody}

**Capability ID:** ${capability.capability_id}
**Expires at:** ${capability.expires_at}`);
    // ---------------------------------------------------------------------------
    // Section 4: Output Format
    // ---------------------------------------------------------------------------
    sections.push(`# Output Expectations

When your work is complete, call \`task.complete\` via the MCP gateway with:
- A brief summary of what was done
- The list of files changed (if any)
- Any blockers or issues that should be noted

If you encounter a blocker you cannot resolve, call \`task.request_help\` with
a structured description: what you tried, what failed, what decision is needed.

Do not output placeholder code, mock data, or TODO stubs. Every implementation
must be real and functional. If something cannot be implemented yet, say so
explicitly with a NOTE: comment.`);
    // ---------------------------------------------------------------------------
    // Section 5 (optional): Vision context
    // ---------------------------------------------------------------------------
    if (extensions.visionContext) {
        const v = extensions.visionContext;
        const parts = [];
        if (v.title)
            parts.push(`**Title:** ${v.title}`);
        if (v.summary)
            parts.push(`**Summary:** ${v.summary}`);
        if (v.goals && v.goals.length > 0) {
            parts.push(`**Goals:**\n${v.goals.map((g) => `- ${g}`).join('\n')}`);
        }
        if (v.nonGoals && v.nonGoals.length > 0) {
            parts.push(`**Non-goals:**\n${v.nonGoals.map((g) => `- ${g}`).join('\n')}`);
        }
        if (v.existingEpicTitles && v.existingEpicTitles.length > 0) {
            parts.push(`**Existing epics:**\n${v.existingEpicTitles.map((t) => `- ${t}`).join('\n')}`);
        }
        if (parts.length > 0) {
            sections.push(`# Vision Context\n\n${parts.join('\n\n')}`);
        }
    }
    // ---------------------------------------------------------------------------
    // Section 6 (optional): Conversation history
    // ---------------------------------------------------------------------------
    if (extensions.conversationHistory && extensions.conversationHistory.messages.length > 0) {
        const lines = extensions.conversationHistory.messages.map((m) => `**${m.author}:** ${m.body}`);
        sections.push(`# Conversation So Far\n\n${lines.join('\n\n')}`);
    }
    // ---------------------------------------------------------------------------
    // Section 7 (optional): Project memory — injected by Round 6 Task #4
    // [Engineer-Sr · Sonnet · run-round6-04-project-memory]
    // ---------------------------------------------------------------------------
    if (memoryInjection && memoryInjection.markdown) {
        sections.push(memoryInjection.markdown);
    }
    return sections.join('\n\n---\n\n');
}
/**
 * Synchronous variant of buildBrief — does NOT inject project memory.
 * Use this only when you cannot await (e.g., legacy callers).
 * For full memory injection, use the async buildBrief.
 */
export function buildBriefSync(persona, task, capability, extensions = {}) {
    // Delegate to the async function and suppress memory context
    // Since this is sync we return a Promise-like by using a resolved stub.
    // Callers that need memory MUST use the async version.
    const sections = [];
    sections.push(`# Role: ${persona.displayName}\n\n${persona.roleBriefMd}`);
    const acLines = task.acceptance_criteria.length > 0
        ? task.acceptance_criteria.map((ac, i) => `${i + 1}. ${ac}`).join('\n')
        : '(No acceptance criteria specified)';
    sections.push(`# Task\n\n**Task ID:** ${task.task_id}\n**Title:** ${task.title}\n**Risk Class:** ${task.risk_class ?? 'standard'}\n\n## Description\n\n${task.description}\n\n## Acceptance Criteria\n\n${acLines}`);
    const scopes = capability.scopes;
    const scopeParts = [];
    if (scopes.files_read?.length)
        scopeParts.push(`**Files you may READ:** ${scopes.files_read.join(', ')}`);
    if (scopes.files_write?.length)
        scopeParts.push(`**Files you may WRITE:** ${scopes.files_write.join(', ')}`);
    if (scopes.channel_post?.length)
        scopeParts.push(`**Channels you may POST to:** ${scopes.channel_post.join(', ')}`);
    if (scopes.channel_read?.length)
        scopeParts.push(`**Channels you may READ:** ${scopes.channel_read.join(', ')}`);
    if (scopes.board_mutate?.length)
        scopeParts.push(`**Board fields you may MUTATE:** ${scopes.board_mutate.join(', ')}`);
    if (scopes.secrets?.length)
        scopeParts.push(`**Secrets you may ACCESS:** ${scopes.secrets.join(', ')}`);
    if (scopes.network_egress?.length)
        scopeParts.push(`**Network egress allowed to:** ${scopes.network_egress.join(', ')}`);
    if (scopes.git_commit?.length) {
        const gs = scopes.git_commit.map((g) => `branch \`${g.branch}\` / paths \`${g.paths.join(', ')}\``).join('; ');
        scopeParts.push(`**Git commits allowed:** ${gs}`);
    }
    const scopeBody = scopeParts.length > 0 ? scopeParts.join('\n') : '(No explicit scopes — all tool calls will be denied)';
    sections.push(`# Capability Scope\n\nYour capability bundle grants you the following permissions. The MCP gateway\nenforces these strictly — any tool call outside this scope will be denied.\n\n${scopeBody}\n\n**Capability ID:** ${capability.capability_id}\n**Expires at:** ${capability.expires_at}`);
    sections.push(`# Output Expectations\n\nWhen your work is complete, call \`task.complete\` via the MCP gateway with:\n- A brief summary of what was done\n- The list of files changed (if any)\n- Any blockers or issues that should be noted\n\nIf you encounter a blocker you cannot resolve, call \`task.request_help\` with\na structured description: what you tried, what failed, what decision is needed.\n\nDo not output placeholder code, mock data, or TODO stubs. Every implementation\nmust be real and functional. If something cannot be implemented yet, say so\nexplicitly with a NOTE: comment.`);
    if (extensions.visionContext) {
        const v = extensions.visionContext;
        const parts = [];
        if (v.title)
            parts.push(`**Title:** ${v.title}`);
        if (v.summary)
            parts.push(`**Summary:** ${v.summary}`);
        if (v.goals?.length)
            parts.push(`**Goals:**\n${v.goals.map((g) => `- ${g}`).join('\n')}`);
        if (v.nonGoals?.length)
            parts.push(`**Non-goals:**\n${v.nonGoals.map((g) => `- ${g}`).join('\n')}`);
        if (v.existingEpicTitles?.length)
            parts.push(`**Existing epics:**\n${v.existingEpicTitles.map((t) => `- ${t}`).join('\n')}`);
        if (parts.length > 0)
            sections.push(`# Vision Context\n\n${parts.join('\n\n')}`);
    }
    if (extensions.conversationHistory?.messages.length) {
        const lines = extensions.conversationHistory.messages.map((m) => `**${m.author}:** ${m.body}`);
        sections.push(`# Conversation So Far\n\n${lines.join('\n\n')}`);
    }
    return sections.join('\n\n---\n\n');
}
//# sourceMappingURL=brief.js.map