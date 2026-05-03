/**
 * PersonaLoader — scans baseline library + optional user override path,
 * validates definitions, upserts to DB, emits lifecycle events.
 *
 * Per TRD-03 §14.1 (boot-time loading) and Implementation Plan §6 Task 2A.
 *
 * Load order:
 * 1. BASELINE_PERSONAS (always loaded from library/index.ts)
 * 2. `~/.orbital/config/personas/` file-system scan (user overrides; last wins on slug)
 *
 * If the override path does not exist, it is silently skipped.
 * A broken user persona is logged at error level and skipped; boot continues.
 */
import type { DB } from '../db/client.js';
import type { EventStore } from '../events/store.js';
import type { Persona } from './types.js';
export interface PersonaLoader {
    /** Scans library + user override path; upserts to DB; emits events. */
    load(): Promise<void>;
    /** Get a single persona by ID. Throws if not found. */
    get(personaId: string): Promise<Persona>;
    /** Return all non-archived personas. */
    getActive(): Promise<Persona[]>;
}
export declare class DefaultPersonaLoader implements PersonaLoader {
    private readonly db;
    private readonly eventStore;
    constructor(db: DB, eventStore: EventStore);
    load(): Promise<void>;
    get(personaId: string): Promise<Persona>;
    getActive(): Promise<Persona[]>;
    private collectDefinitions;
    private upsertPersona;
    private nextVersionNumber;
    private insertSkillsForVersion;
    private createStubSkillVersion;
    private insertModelAffinitiesForVersion;
    private computeHash;
    private computeStringHash;
    private assemblePersona;
}
export declare function createPersonaLoader(db: DB, eventStore: EventStore): PersonaLoader;
//# sourceMappingURL=loader.d.ts.map