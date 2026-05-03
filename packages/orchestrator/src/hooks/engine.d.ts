/**
 * hooks/engine.ts — HookEngine: fail-closed hook dispatch.
 *
 * Per TRD-09 §6.2.1, §6.2.2.
 *
 * Algorithm (§6.2.2):
 *  1. Look up all hooks for (eventType, timing) sorted by declared_order ASC, then hook_id ASC.
 *  2. For each enabled hook:
 *     a. Call validator(payload, context) — catch any throw → HOOK_INTERNAL_ERROR.
 *     b. Write hook_invocations row (best-effort, background).
 *     c. Emit HookFired event (EventStore.append — never db.insert(events)).
 *     d. If allow → emit HookPassed; continue.
 *        If reject → emit HookRejected; SHORT-CIRCUIT; return reject decision.
 *  3. If all pass → return { allow: true }.
 *
 * Fail-closed: any exception from a hook validator is treated as a rejection.
 * Pure, in-process: hooks have no I/O surface beyond their inputs.
 */
import type { EventStore } from '../events/store.js';
import type { DB } from '../db/client.js';
import type { HookDefinition, HookContext, HookEngineDecision } from './types.js';
export declare class HookEngine {
    private readonly eventStore;
    private readonly db;
    /**
     * Registry: eventType → timing → sorted HookDefinition[]
     * Sorted by declared_order ASC, then hook_id ASC (tie-breaking per TRD-09 §6.2.2).
     */
    private readonly registry;
    constructor(eventStore: EventStore, db?: DB);
    register(hook: HookDefinition): void;
    fire(eventType: string, payload: unknown, context: HookContext, timing: 'pre' | 'post'): Promise<HookEngineDecision>;
    private lookupHooks;
    private writeInvocationAndEvents;
}
//# sourceMappingURL=engine.d.ts.map