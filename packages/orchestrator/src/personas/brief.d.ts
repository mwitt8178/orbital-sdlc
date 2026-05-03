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
import type { Persona } from './types.js';
import type { CapabilityBundle } from '@orbital/types';
import type { DB } from '../db/client.js';
import type { EventStore } from '../events/store.js';
import type { RoutingEngine } from '../routing/engine.js';
export interface BriefTask {
    task_id: string;
    title: string;
    description: string;
    acceptance_criteria: string[];
    risk_class?: string;
}
/**
 * Optional conversation history appended to the brief. Used by chat-style
 * persona invocations (PM intake, persona-of-record reasoning) where the
 * model needs to see prior turns to respond intelligibly.
 */
export interface BriefConversationHistory {
    messages: Array<{
        /** Author of the message — typically 'user' or a persona slug. */
        author: string;
        body: string;
    }>;
}
/**
 * Optional vision context. The PM and NL parser personas pull the locked-or
 * draft vision document into the brief so the model has product context
 * without needing tool calls.
 */
export interface BriefVisionContext {
    title?: string;
    summary?: string;
    goals?: string[];
    /** Optional non-goals (out-of-scope items). */
    nonGoals?: string[];
    /** Optional list of existing epic titles, for the NL parser. */
    existingEpicTitles?: string[];
}
/**
 * Optional memory context for brief injection.
 * When provided, the brief builder calls memory.retrieveTopN() and appends
 * the formatted entries as a "Project memory" section.
 *
 * [Engineer-Sr · Sonnet · run-round6-04-project-memory]
 */
export interface BriefMemoryContext {
    db: DB;
    eventStore: EventStore;
    projectId: string;
    /** Number of entries to retrieve (default: 8) */
    k?: number;
}
export interface BriefExtensions {
    /** Conversation history; rendered as a "Conversation so far" section. */
    conversationHistory?: BriefConversationHistory;
    /** Vision context; rendered as a "Vision context" section. */
    visionContext?: BriefVisionContext;
    /**
     * Memory context for injecting project memory entries.
     * When provided, the builder retrieves and appends relevant entries.
     * When absent, no memory section is added (backwards compatible).
     */
    memoryContext?: BriefMemoryContext;
    /**
     * Round 6 #8 — when set, routeModel() is called to determine the
     * provider+model for this spawn and a model badge is added to the brief
     * header.
     */
    routingContext?: {
        routingEngine: RoutingEngine;
        /** S/M/L/XL estimate used for routing. */
        estimate: 'S' | 'M' | 'L' | 'XL';
        /** Author's provider (for cross-family SoD rule). */
        authorProvider?: string;
        /** Author's model (for cross-family SoD rule). */
        authorModel?: string;
        traceId?: string;
    };
}
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
export declare function buildBrief(persona: Persona, task: BriefTask, capability: CapabilityBundle, extensions?: BriefExtensions): Promise<string>;
/**
 * Synchronous variant of buildBrief — does NOT inject project memory.
 * Use this only when you cannot await (e.g., legacy callers).
 * For full memory injection, use the async buildBrief.
 */
export declare function buildBriefSync(persona: Persona, task: BriefTask, capability: CapabilityBundle, extensions?: Omit<BriefExtensions, 'memoryContext'>): string;
//# sourceMappingURL=brief.d.ts.map