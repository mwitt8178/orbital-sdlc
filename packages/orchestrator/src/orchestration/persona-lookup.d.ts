/**
 * persona-lookup.ts — orchestration-internal helper to resolve a persona
 * by either UUID personaId or by slug.
 *
 * Why: `tasks.persona_id` is a `text` column that callers in TRD-04 use to
 * store the persona slug (e.g. 'sr-dev'). PersonaLoader.get accepts a UUID.
 * This helper bridges the two so the scheduler / pause / scheduler don't
 * need to know which form is in the column.
 */
import type { DB } from '../db/client.js';
import type { PersonaLoader } from '../personas/loader.js';
import type { Persona } from '../personas/types.js';
/**
 * Resolve a persona by the value stored in `tasks.persona_id`. Tries:
 *  1. PersonaLoader.get(personaIdOrSlug) — works if it's a UUID.
 *  2. SELECT personas WHERE slug=$1 → loader.get(uuid).
 *
 * Throws if neither lookup succeeds.
 */
export declare function resolvePersona(db: DB, loader: PersonaLoader, personaIdOrSlug: string): Promise<Persona>;
//# sourceMappingURL=persona-lookup.d.ts.map