/**
 * persona-lookup.ts — orchestration-internal helper to resolve a persona
 * by either UUID personaId or by slug.
 *
 * Why: `tasks.persona_id` is a `text` column that callers in TRD-04 use to
 * store the persona slug (e.g. 'sr-dev'). PersonaLoader.get accepts a UUID.
 * This helper bridges the two so the scheduler / pause / scheduler don't
 * need to know which form is in the column.
 */
import { eq } from 'drizzle-orm';
import { personas } from '../db/schema/personas.js';
/**
 * Resolve a persona by the value stored in `tasks.persona_id`. Tries:
 *  1. PersonaLoader.get(personaIdOrSlug) — works if it's a UUID.
 *  2. SELECT personas WHERE slug=$1 → loader.get(uuid).
 *
 * Throws if neither lookup succeeds.
 */
export async function resolvePersona(db, loader, personaIdOrSlug) {
    // Try UUID first.
    try {
        const p = await loader.get(personaIdOrSlug);
        return p;
    }
    catch {
        // Fall through to slug lookup.
    }
    const rows = await db
        .select()
        .from(personas)
        .where(eq(personas.slug, personaIdOrSlug))
        .limit(1);
    const row = rows[0];
    if (!row) {
        throw new Error(`NOT_FOUND_PERSONA: no persona with id-or-slug '${personaIdOrSlug}'`);
    }
    return loader.get(row.personaId);
}
//# sourceMappingURL=persona-lookup.js.map