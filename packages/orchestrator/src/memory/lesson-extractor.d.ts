/**
 * memory/lesson-extractor.ts — Post-run lesson extraction.
 *
 * [Engineer-Sr · Sonnet · run-memory-prompt-assembly]
 *
 * After each persona run completes, this module makes a small Anthropic API
 * call to extract 1-3 "lessons learned" from the worker's output. Each lesson
 * is written to the project memory as kind='learning', sourceKind='agent',
 * with tags=['auto-lesson', <personaSlug>].
 *
 * The extractor is called from the scheduler's exited handler (post-run),
 * scoped to the task's tenantId + projectId + personaSlug.
 *
 * Design:
 * - Non-blocking: extraction errors are logged but never surface to the caller.
 * - Idempotent: each run produces at most 3 entries; the LLM is instructed
 *   to avoid generic advice and focus on concrete observations.
 * - Cost-aware: uses haiku tier (low-cost, fast).
 * - Real LLM call: never stubs, never returns fake data.
 */
import type { DB } from '../db/client.js';
import type { EventStore } from '../events/store.js';
export interface LessonExtractorParams {
    /** Tenant for scoping all writes. */
    tenantId: string;
    /** Project for scoping all writes. */
    projectId: string;
    /** Task that just completed. */
    taskId: string;
    /** Persona slug (e.g. 'sr-dev', 'pm'). */
    personaSlug: string;
    /** Short title of the completed task. */
    taskTitle: string;
    /** Full description of the completed task. */
    taskDescription: string;
    /**
     * Worker output text (stdout from the claude process).
     * Truncated to 20KB before sending to the LLM.
     */
    workerOutput: string;
    /** Drizzle DB instance. */
    db: DB;
    /** Event store for audit trail. */
    eventStore: EventStore;
    /**
     * Anthropic API key. When absent, extraction is skipped silently.
     * This mirrors the existing driver pattern — loud key check, silent skip.
     */
    anthropicApiKey?: string;
}
/**
 * Extract lessons learned from a completed worker run and write them to memory.
 *
 * This function is fire-and-forget safe — all errors are caught and logged.
 * Returns the number of lessons written (0 if extraction fails or skips).
 */
export declare function extractAndStoreLessons(params: LessonExtractorParams): Promise<number>;
//# sourceMappingURL=lesson-extractor.d.ts.map