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
import { createHash } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import { uuidv7 } from 'uuidv7';
import { eq } from 'drizzle-orm';
import { logger } from '../config/logger.js';
import { getOrbitalHome } from '../config/env.js';
import { personas, personaVersions, skillVersions, skills, personaSkills, personaCapabilities, personaModelAffinities, } from '../db/schema/personas.js';
import { PersonaDefinitionSchema } from './types.js';
import { BASELINE_PERSONAS } from './library/index.js';
// ---------------------------------------------------------------------------
// System actor used for loader-originated events
// ---------------------------------------------------------------------------
const LOADER_ACTOR = {
    type: 'system',
    component: 'orchestrator',
};
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
export class DefaultPersonaLoader {
    db;
    eventStore;
    constructor(db, eventStore) {
        this.db = db;
        this.eventStore = eventStore;
    }
    // --------------------------------------------------------------------------
    // load
    // --------------------------------------------------------------------------
    async load() {
        const definitions = await this.collectDefinitions();
        let loaded = 0;
        let updated = 0;
        let skipped = 0;
        let failed = 0;
        for (const def of definitions) {
            try {
                const result = await this.upsertPersona(def);
                if (result === 'created')
                    loaded++;
                else if (result === 'updated')
                    updated++;
                else
                    skipped++;
            }
            catch (err) {
                failed++;
                logger.error({ err, slug: def.slug }, 'PersonaLoader: failed to upsert persona — skipping');
            }
        }
        logger.info({ loaded, updated, skipped, failed, total: definitions.length }, 'personas_loaded');
    }
    // --------------------------------------------------------------------------
    // get
    // --------------------------------------------------------------------------
    async get(personaId) {
        const rows = await this.db
            .select()
            .from(personas)
            .where(eq(personas.personaId, personaId))
            .limit(1);
        const row = rows[0];
        if (!row)
            throw new Error(`NOT_FOUND_PERSONA: ${personaId}`);
        if (!row.currentVersionId)
            throw new Error(`INTERNAL_DB_ERROR: persona ${personaId} has no current version`);
        return this.assemblePersona(row.personaId, row.currentVersionId);
    }
    // --------------------------------------------------------------------------
    // getActive
    // --------------------------------------------------------------------------
    async getActive() {
        const rows = await this.db
            .select()
            .from(personas)
            .where(eq(personas.isArchived, false));
        const result = [];
        for (const row of rows) {
            if (!row.currentVersionId)
                continue;
            try {
                const p = await this.assemblePersona(row.personaId, row.currentVersionId);
                result.push(p);
            }
            catch (err) {
                logger.warn({ err, personaId: row.personaId }, 'PersonaLoader.getActive: skipping persona');
            }
        }
        return result;
    }
    // --------------------------------------------------------------------------
    // Private: collect definitions from library + user override path
    // --------------------------------------------------------------------------
    async collectDefinitions() {
        const defsMap = new Map();
        // 1. Baseline library (always loaded)
        for (const def of BASELINE_PERSONAS) {
            defsMap.set(def.slug, def);
        }
        // 2. User override path — gracefully skip if absent
        try {
            const overridePath = path.join(getOrbitalHome(), 'config', 'personas');
            const entries = await fs.readdir(overridePath).catch(() => null);
            if (entries) {
                for (const entry of entries) {
                    if (!entry.endsWith('.ts') && !entry.endsWith('.js'))
                        continue;
                    const fullPath = path.join(overridePath, entry);
                    try {
                        const mod = await import(fullPath);
                        const def = mod.definition ?? mod.default;
                        const validated = PersonaDefinitionSchema.parse(def);
                        defsMap.set(validated.slug, validated);
                        logger.debug({ slug: validated.slug, path: fullPath }, 'PersonaLoader: loaded user persona');
                    }
                    catch (err) {
                        logger.error({ err, path: fullPath }, 'PersonaLoader: user persona invalid — skipping');
                    }
                }
            }
        }
        catch {
            // Override path not accessible; continue with baselines only
        }
        return Array.from(defsMap.values());
    }
    // --------------------------------------------------------------------------
    // Private: upsert a single persona definition
    // --------------------------------------------------------------------------
    async upsertPersona(def) {
        const hash = this.computeHash(def);
        const now = new Date().toISOString();
        const traceId = uuidv7();
        // Look up existing persona by slug
        const existingRows = await this.db
            .select()
            .from(personas)
            .where(eq(personas.slug, def.slug))
            .limit(1);
        const existing = existingRows[0];
        if (existing) {
            // Check if the current version's hash matches
            if (existing.currentVersionId) {
                const versionRows = await this.db
                    .select()
                    .from(personaVersions)
                    .where(eq(personaVersions.personaVersionId, existing.currentVersionId))
                    .limit(1);
                const currentVersion = versionRows[0];
                if (currentVersion && currentVersion.definitionHash === hash) {
                    // No change — skip
                    return 'noop';
                }
            }
            // New version needed
            const personaId = existing.personaId;
            const newVersionNumber = await this.nextVersionNumber(personaId);
            const versionId = uuidv7();
            await this.db.transaction(async (tx) => {
                // Insert persona_version
                await tx.insert(personaVersions).values({
                    personaVersionId: versionId,
                    personaId,
                    versionNumber: newVersionNumber,
                    roleBriefMd: def.roleBrief.bodyMd,
                    definitionJson: def,
                    definitionHash: hash,
                    escalationPolicy: def.escalationPolicy,
                    publishedByActor: LOADER_ACTOR,
                    justification: `Loaded from library at ${now}`,
                    parentVersionId: existing.currentVersionId ?? undefined,
                    schemaVersion: 1,
                });
                // Insert relationship rows
                await this.insertSkillsForVersion(tx, versionId, def);
                await tx.insert(personaCapabilities).values({
                    personaVersionId: versionId,
                    defaultProfileJson: def.defaultCapabilityProfile,
                });
                await this.insertModelAffinitiesForVersion(tx, versionId, def);
                // Advance current_version_id
                await tx
                    .update(personas)
                    .set({ currentVersionId: versionId })
                    .where(eq(personas.personaId, personaId));
            });
            // Emit events
            await this.eventStore.append({
                aggregate_id: existing.personaId,
                aggregate_type: 'persona',
                event_type: 'PersonaVersionPublished',
                payload: {
                    persona_id: existing.personaId,
                    persona_version_id: versionId,
                    version_number: newVersionNumber,
                    parent_version_id: existing.currentVersionId ?? null,
                    definition_hash: hash,
                    retro_proposal_id: null,
                    justification: `Loaded from library at ${now}`,
                    diff_summary: {
                        role_brief_changed: true,
                        skills_added: [],
                        skills_removed: [],
                        capability_profile_changed: true,
                        model_affinity_changed: true,
                        escalation_policy_changed: true,
                    },
                },
                actor: LOADER_ACTOR,
                trace_id: traceId,
                occurred_at: now,
                schema_version: 1,
            });
            await this.eventStore.append({
                aggregate_id: existing.personaId,
                aggregate_type: 'persona',
                event_type: 'PersonaUpdated',
                payload: {
                    persona_id: existing.personaId,
                    new_current_version_id: versionId,
                },
                actor: LOADER_ACTOR,
                trace_id: traceId,
                occurred_at: now,
                schema_version: 1,
            });
            return 'updated';
        }
        // --- Create new persona ---
        const personaId = uuidv7();
        const versionId = uuidv7();
        await this.db.transaction(async (tx) => {
            // Insert persona head row first
            await tx.insert(personas).values({
                personaId,
                slug: def.slug,
                origin: def.origin,
                currentVersionId: null, // will be set after version is inserted
                isArchived: false,
                createdByActor: LOADER_ACTOR,
            });
            // Insert version
            await tx.insert(personaVersions).values({
                personaVersionId: versionId,
                personaId,
                versionNumber: 1,
                roleBriefMd: def.roleBrief.bodyMd,
                definitionJson: def,
                definitionHash: hash,
                escalationPolicy: def.escalationPolicy,
                publishedByActor: LOADER_ACTOR,
                justification: `Initial load from library at ${now}`,
                parentVersionId: undefined,
                schemaVersion: 1,
            });
            // Insert relationship rows
            await this.insertSkillsForVersion(tx, versionId, def);
            await tx.insert(personaCapabilities).values({
                personaVersionId: versionId,
                defaultProfileJson: def.defaultCapabilityProfile,
            });
            await this.insertModelAffinitiesForVersion(tx, versionId, def);
            // Set current_version_id
            await tx
                .update(personas)
                .set({ currentVersionId: versionId })
                .where(eq(personas.personaId, personaId));
        });
        // Emit events
        await this.eventStore.append({
            aggregate_id: personaId,
            aggregate_type: 'persona',
            event_type: 'PersonaCreated',
            payload: {
                persona_id: personaId,
                slug: def.slug,
                origin: def.origin,
                initial_version_id: versionId,
            },
            actor: LOADER_ACTOR,
            trace_id: traceId,
            occurred_at: now,
            schema_version: 1,
        });
        await this.eventStore.append({
            aggregate_id: personaId,
            aggregate_type: 'persona',
            event_type: 'PersonaVersionPublished',
            payload: {
                persona_id: personaId,
                persona_version_id: versionId,
                version_number: 1,
                parent_version_id: null,
                definition_hash: hash,
                retro_proposal_id: null,
                justification: `Initial load from library at ${now}`,
                diff_summary: {
                    role_brief_changed: true,
                    skills_added: def.skills.map((s) => s.slug),
                    skills_removed: [],
                    capability_profile_changed: true,
                    model_affinity_changed: true,
                    escalation_policy_changed: true,
                },
            },
            actor: LOADER_ACTOR,
            trace_id: traceId,
            occurred_at: now,
            schema_version: 1,
        });
        return 'created';
    }
    // --------------------------------------------------------------------------
    // Private helpers
    // --------------------------------------------------------------------------
    async nextVersionNumber(personaId) {
        const rows = await this.db
            .select()
            .from(personaVersions)
            .where(eq(personaVersions.personaId, personaId));
        return rows.length + 1;
    }
    async insertSkillsForVersion(tx, versionId, def) {
        for (const skillRef of def.skills) {
            // Upsert skill head row
            const existingSkills = await tx
                .select()
                .from(skills)
                .where(eq(skills.slug, skillRef.slug))
                .limit(1);
            let skillId;
            let skillVersionId;
            if (existingSkills[0]?.skillId) {
                skillId = existingSkills[0].skillId;
                skillVersionId = existingSkills[0].currentVersionId ?? uuidv7();
                if (!existingSkills[0].currentVersionId) {
                    // Orphan — create a stub version
                    skillVersionId = await this.createStubSkillVersion(tx, skillId, skillRef.slug);
                }
            }
            else {
                skillId = uuidv7();
                skillVersionId = uuidv7();
                const now = new Date().toISOString();
                await tx.insert(skills).values({
                    skillId,
                    slug: skillRef.slug,
                    origin: 'baseline',
                    currentVersionId: null,
                    isArchived: false,
                });
                await tx.insert(skillVersions).values({
                    skillVersionId,
                    skillId,
                    versionNumber: 1,
                    frontmatterJson: { slug: skillRef.slug, display_name: skillRef.slug },
                    bodyMd: `# ${skillRef.slug}\n\nSkill definition pending.`,
                    contentHash: this.computeStringHash(skillRef.slug),
                    publishedByActor: LOADER_ACTOR,
                    justification: `Auto-created stub for persona ${now}`,
                    schemaVersion: 1,
                });
                await tx
                    .update(skills)
                    .set({ currentVersionId: skillVersionId })
                    .where(eq(skills.skillId, skillId));
            }
            await tx.insert(personaSkills).values({
                personaVersionId: versionId,
                skillVersionId,
                required: skillRef.required,
                ordering: skillRef.ordering,
            });
        }
    }
    async createStubSkillVersion(tx, skillId, slug) {
        const skillVersionId = uuidv7();
        await tx.insert(skillVersions).values({
            skillVersionId,
            skillId,
            versionNumber: 1,
            frontmatterJson: { slug, display_name: slug },
            bodyMd: `# ${slug}\n\nSkill definition pending.`,
            contentHash: this.computeStringHash(slug),
            publishedByActor: LOADER_ACTOR,
            justification: 'Auto-created stub',
            schemaVersion: 1,
        });
        await tx
            .update(skills)
            .set({ currentVersionId: skillVersionId })
            .where(eq(skills.skillId, skillId));
        return skillVersionId;
    }
    async insertModelAffinitiesForVersion(tx, versionId, def) {
        for (const affinity of def.modelAffinity) {
            await tx.insert(personaModelAffinities).values({
                personaVersionId: versionId,
                riskClass: affinity.riskClass,
                preferredModel: affinity.preferredModel,
                fallbackModel: affinity.fallbackModel ?? undefined,
                maxTokensHint: affinity.maxTokensHint ?? undefined,
                rationale: affinity.rationale,
            });
        }
    }
    computeHash(def) {
        const normalized = JSON.stringify(def, Object.keys(def).sort());
        return createHash('sha256').update(normalized).digest('hex');
    }
    computeStringHash(s) {
        return createHash('sha256').update(s).digest('hex');
    }
    // --------------------------------------------------------------------------
    // Private: assemble full Persona from DB rows
    // --------------------------------------------------------------------------
    async assemblePersona(personaId, versionId) {
        const [versionRows, capRows, affinityRows, skillRows] = await Promise.all([
            this.db
                .select()
                .from(personaVersions)
                .where(eq(personaVersions.personaVersionId, versionId))
                .limit(1),
            this.db
                .select()
                .from(personaCapabilities)
                .where(eq(personaCapabilities.personaVersionId, versionId))
                .limit(1),
            this.db
                .select()
                .from(personaModelAffinities)
                .where(eq(personaModelAffinities.personaVersionId, versionId)),
            this.db
                .select()
                .from(personaSkills)
                .where(eq(personaSkills.personaVersionId, versionId)),
        ]);
        const version = versionRows[0];
        if (!version)
            throw new Error(`INTERNAL_DB_ERROR: persona_version ${versionId} not found`);
        const cap = capRows[0];
        if (!cap)
            throw new Error(`INTERNAL_DB_ERROR: persona_capability for version ${versionId} not found`);
        const personaRows = await this.db
            .select()
            .from(personas)
            .where(eq(personas.personaId, personaId))
            .limit(1);
        const personaRow = personaRows[0];
        if (!personaRow)
            throw new Error(`INTERNAL_DB_ERROR: persona ${personaId} not found`);
        const def = version.definitionJson;
        return {
            personaId,
            personaVersionId: versionId,
            slug: personaRow.slug,
            displayName: def.displayName,
            origin: def.origin,
            versionNumber: version.versionNumber,
            roleBriefMd: version.roleBriefMd,
            definitionHash: version.definitionHash,
            defaultCapabilityProfile: cap.defaultProfileJson,
            modelAffinity: affinityRows.map((a) => ({
                riskClass: a.riskClass,
                preferredModel: a.preferredModel,
                fallbackModel: (a.fallbackModel ?? null),
                maxTokensHint: a.maxTokensHint ?? null,
                rationale: a.rationale,
            })),
            escalationPolicy: version.escalationPolicy,
            skills: skillRows.map((s) => ({
                slug: 'unknown',
                required: s.required,
                ordering: s.ordering,
            })),
            metadata: def.metadata,
            isArchived: personaRow.isArchived,
        };
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createPersonaLoader(db, eventStore) {
    return new DefaultPersonaLoader(db, eventStore);
}
//# sourceMappingURL=loader.js.map