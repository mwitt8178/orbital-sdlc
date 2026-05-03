/**
 * backlog/service.ts — BacklogService.
 *
 * Per TRD-02 v0.2 §6.1.
 *
 * Responsibilities:
 *   - Epic CRUD
 *   - Story CRUD (title, description, AC list, status transitions, estimate)
 *   - Backlog prioritization (move story up/down/to-position)
 *   - Groom (refine + estimate)
 *
 * All mutations:
 *   1. Validate via Zod
 *   2. Acquire row-level advisory lock (per TRD-02 §8.1)
 *   3. Mutate row
 *   4. Append event via EventStore (never raw db.insert(events))
 */
import { uuidv7 } from 'uuidv7';
import { eq, and, asc, desc, sql as dSQL, gte, lte, inArray } from 'drizzle-orm';
const SENTINEL_TENANT = '00000000-0000-0000-0000-000000000000';
import { OrbitalError } from '@orbital/types';
import { epics, stories, storyAcceptanceCriteria, } from '@orbital/db';
import { logger } from '../logger.js';
import { CreateEpicInputSchema, CreateStoryInputSchema, UpdateStoryInputSchema, isValidStoryTransition, BACKLOG_ERROR_CODES, } from './types.js';
const SYSTEM_ACTOR = { type: 'system', component: 'orchestrator' };
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
export class DefaultBacklogService {
    db;
    eventStore;
    constructor(db, eventStore) {
        this.db = db;
        this.eventStore = eventStore;
    }
    // -------------------------------------------------------------------------
    // Epic operations
    // -------------------------------------------------------------------------
    async createEpic(input, actor = SYSTEM_ACTOR, tenantId = SENTINEL_TENANT) {
        const parsed = CreateEpicInputSchema.parse(input);
        const epicId = uuidv7();
        const now = new Date();
        const [row] = await this.db
            .insert(epics)
            .values({
            epicId,
            tenantId,
            visionVersionId: parsed.vision_version_id,
            title: parsed.title,
            rationale: parsed.rationale,
            priority: parsed.priority,
            status: 'draft',
            createdAt: now,
            updatedAt: now,
            schemaVersion: 1,
        })
            .returning();
        if (!row) {
            throw new OrbitalError(BACKLOG_ERROR_CODES.INTERNAL_DB_ERROR, 'INSERT epic returned no rows');
        }
        const ev = {
            aggregate_id: epicId,
            aggregate_type: 'epic',
            event_type: 'EpicCreated',
            payload: {
                epic_id: epicId,
                vision_version_id: parsed.vision_version_id,
                title: parsed.title,
                rationale: parsed.rationale,
                priority: parsed.priority,
            },
            actor,
            trace_id: uuidv7(),
            occurred_at: now.toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(ev);
        return row;
    }
    async listEpics(filter = {}, tenantId = SENTINEL_TENANT) {
        const conditions = [eq(epics.tenantId, tenantId)];
        if (filter.status)
            conditions.push(eq(epics.status, filter.status));
        if (filter.visionVersionId) {
            conditions.push(eq(epics.visionVersionId, filter.visionVersionId));
        }
        const where = and(...conditions);
        return await this.db.select().from(epics).where(where).orderBy(asc(epics.priority));
    }
    async getEpic(epicId, tenantId = SENTINEL_TENANT) {
        const rows = await this.db.select().from(epics).where(and(eq(epics.epicId, epicId), eq(epics.tenantId, tenantId))).limit(1);
        return rows[0] ?? null;
    }
    // -------------------------------------------------------------------------
    // Story operations
    // -------------------------------------------------------------------------
    async createStory(input, actor = SYSTEM_ACTOR, tenantId = SENTINEL_TENANT) {
        const parsed = CreateStoryInputSchema.parse(input);
        // Validate epic exists
        const epic = await this.getEpic(parsed.epic_id, tenantId);
        if (!epic) {
            throw new OrbitalError(BACKLOG_ERROR_CODES.NOT_FOUND_EPIC, `epic ${parsed.epic_id} not found`);
        }
        const storyId = uuidv7();
        const now = new Date();
        const traceId = uuidv7();
        // Determine priority: append to end of epic
        const lastStories = await this.db
            .select({ priority: stories.priority })
            .from(stories)
            .where(and(eq(stories.epicId, parsed.epic_id), eq(stories.tenantId, tenantId)))
            .orderBy(desc(stories.priority))
            .limit(1);
        const nextPriority = parsed.priority ?? ((lastStories[0]?.priority ?? -1) + 1);
        const acceptanceRows = parsed.acceptance_criteria.map((ac, idx) => ({
            acId: uuidv7(),
            storyId,
            ordinal: idx + 1,
            text: ac.text,
            verifierHint: ac.verifier_hint ?? null,
            createdAt: now,
            schemaVersion: 1,
        }));
        // Insert story + ACs in a transaction
        await this.db.transaction(async (tx) => {
            await tx.insert(stories).values({
                storyId,
                tenantId,
                epicId: parsed.epic_id,
                title: parsed.title,
                description: parsed.description,
                status: 'backlog',
                storyPoints: null,
                priority: nextPriority,
                personaOfRecord: parsed.persona_of_record ?? null,
                mondayItemId: null,
                originStoryId: parsed.origin_story_id ?? null,
                defectId: parsed.defect_id ?? null,
                linkedArtifacts: [],
                createdAt: now,
                updatedAt: now,
                schemaVersion: 1,
            });
            await tx.insert(storyAcceptanceCriteria).values(acceptanceRows);
        });
        // Emit StoryCreated
        const ev = {
            aggregate_id: storyId,
            aggregate_type: 'story',
            event_type: 'StoryCreated',
            payload: {
                story_id: storyId,
                epic_id: parsed.epic_id,
                title: parsed.title,
                description: parsed.description,
                acceptance_criteria: acceptanceRows.map((ac) => ({
                    ac_id: ac.acId,
                    ordinal: ac.ordinal,
                    text: ac.text,
                })),
                origin_story_id: parsed.origin_story_id ?? null,
                defect_id: parsed.defect_id ?? null,
                persona_of_record: parsed.persona_of_record ?? null,
            },
            actor,
            trace_id: traceId,
            occurred_at: now.toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(ev);
        return await this.getStoryRequired(storyId);
    }
    async listStories(filter = {}, tenantId = SENTINEL_TENANT) {
        const conditions = [eq(stories.tenantId, tenantId)];
        if (filter.epicId)
            conditions.push(eq(stories.epicId, filter.epicId));
        if (filter.status)
            conditions.push(eq(stories.status, filter.status));
        const where = and(...conditions);
        return await this.db
            .select()
            .from(stories)
            .where(where)
            .orderBy(asc(stories.priority));
    }
    async getStory(storyId, tenantId = SENTINEL_TENANT) {
        const rows = await this.db
            .select()
            .from(stories)
            .where(and(eq(stories.storyId, storyId), eq(stories.tenantId, tenantId)))
            .limit(1);
        const row = rows[0];
        if (!row)
            return null;
        const acs = await this.db
            .select()
            .from(storyAcceptanceCriteria)
            .where(eq(storyAcceptanceCriteria.storyId, storyId))
            .orderBy(asc(storyAcceptanceCriteria.ordinal));
        return { ...row, acceptanceCriteria: acs };
    }
    async getStoryRequired(storyId, tenantId = SENTINEL_TENANT) {
        const story = await this.getStory(storyId, tenantId);
        if (!story) {
            throw new OrbitalError(BACKLOG_ERROR_CODES.NOT_FOUND_STORY, `story ${storyId} not found`);
        }
        return story;
    }
    async updateStory(input, actor = SYSTEM_ACTOR, tenantId = SENTINEL_TENANT) {
        const parsed = UpdateStoryInputSchema.parse(input);
        const traceId = uuidv7();
        // Acquire advisory lock per TRD-02 §8.1, then re-read inside the lock.
        const result = await this.db.transaction(async (tx) => {
            await tx.execute(dSQL `SELECT pg_advisory_xact_lock(hashtext(${'story:' + parsed.story_id}))`);
            const rows = await tx
                .select()
                .from(stories)
                .where(and(eq(stories.storyId, parsed.story_id), eq(stories.tenantId, tenantId)))
                .limit(1);
            const current = rows[0];
            if (!current) {
                throw new OrbitalError(BACKLOG_ERROR_CODES.NOT_FOUND_STORY, `story ${parsed.story_id} not found`);
            }
            // Status transition validation
            let willEmitStatusChange = false;
            let fromStatus = current.status;
            let toStatus = current.status;
            if (parsed.status && parsed.status !== current.status) {
                if (!isValidStoryTransition(current.status, parsed.status)) {
                    throw new OrbitalError(BACKLOG_ERROR_CODES.CONFLICT_INVALID_STATE_TRANSITION, `invalid story transition: ${current.status} -> ${parsed.status}`, { from: current.status, to: parsed.status });
                }
                // FR-2.6 enforcement: linked artifacts required for certain transitions
                const transitionRequires = this.linkedArtifactRequirement(current.status, parsed.status);
                if (transitionRequires) {
                    const arts = parsed.linked_artifacts ?? [];
                    const ok = arts.some((a) => transitionRequires.includes(a.type));
                    if (!ok) {
                        throw new OrbitalError(BACKLOG_ERROR_CODES.VALIDATION_LINKED_ARTIFACT_MISSING, `transition ${current.status}->${parsed.status} requires linked_artifacts of type [${transitionRequires.join(',')}]`, { required_types: transitionRequires });
                    }
                }
                fromStatus = current.status;
                toStatus = parsed.status;
                willEmitStatusChange = true;
            }
            const patch = { updatedAt: new Date() };
            if (parsed.title !== undefined)
                patch.title = parsed.title;
            if (parsed.description !== undefined)
                patch.description = parsed.description;
            if (parsed.story_points !== undefined)
                patch.storyPoints = parsed.story_points;
            if (parsed.persona_of_record !== undefined)
                patch.personaOfRecord = parsed.persona_of_record;
            if (parsed.status !== undefined)
                patch.status = parsed.status;
            if (parsed.linked_artifacts !== undefined) {
                patch.linkedArtifacts = parsed.linked_artifacts;
            }
            await tx.update(stories).set(patch).where(and(eq(stories.storyId, parsed.story_id), eq(stories.tenantId, tenantId)));
            if (willEmitStatusChange) {
                return { current, fromStatus, toStatus, willEmitStatusChange };
            }
            return { current, fromStatus, toStatus, willEmitStatusChange };
        });
        // Emit events outside the transaction (EventStore handles its own commit)
        if (result.willEmitStatusChange) {
            const ev = {
                aggregate_id: parsed.story_id,
                aggregate_type: 'story',
                event_type: 'StoryStatusChanged',
                payload: {
                    story_id: parsed.story_id,
                    from_status: result.fromStatus,
                    to_status: result.toStatus,
                    reason: parsed.reason ?? '',
                    linked_artifacts: parsed.linked_artifacts ?? [],
                },
                actor,
                trace_id: traceId,
                occurred_at: new Date().toISOString(),
                schema_version: 1,
            };
            await this.eventStore.append(ev);
        }
        else {
            // emit StoryRefined for non-status patches
            const ev = {
                aggregate_id: parsed.story_id,
                aggregate_type: 'story',
                event_type: 'StoryRefined',
                payload: {
                    story_id: parsed.story_id,
                    ceremony_id: null,
                    changes: {
                        ...(parsed.description !== undefined ? { description: parsed.description } : {}),
                        ac_added: [],
                        ac_removed: [],
                        dependencies_added: [],
                    },
                },
                actor,
                trace_id: traceId,
                occurred_at: new Date().toISOString(),
                schema_version: 1,
            };
            await this.eventStore.append(ev);
        }
        return await this.getStoryRequired(parsed.story_id, tenantId);
    }
    linkedArtifactRequirement(from, to) {
        if (from === 'in_review' && to === 'done')
            return ['pr', 'commit'];
        if (from === 'done' && to === 'accepted')
            return ['uat_result'];
        if (from === 'done' && to === 'defective')
            return ['defect', 'failed_ac_id'];
        return null;
    }
    // -------------------------------------------------------------------------
    // Prioritization
    // -------------------------------------------------------------------------
    async movStoryToPosition(storyId, position, actor = SYSTEM_ACTOR, tenantId = SENTINEL_TENANT) {
        if (position < 0) {
            throw new OrbitalError(BACKLOG_ERROR_CODES.VALIDATION_REQUIRED_FIELD_MISSING, 'position must be >= 0');
        }
        const traceId = uuidv7();
        const now = new Date();
        const story = await this.getStory(storyId, tenantId);
        if (!story) {
            throw new OrbitalError(BACKLOG_ERROR_CODES.NOT_FOUND_STORY, `story ${storyId} not found`);
        }
        // Renumber within the epic. The new position becomes story.priority,
        // and existing rows in the affected range shift by ±1.
        const oldPriority = story.priority;
        if (oldPriority === position)
            return;
        const changes = [];
        await this.db.transaction(async (tx) => {
            // Lock the epic-level row range
            await tx.execute(dSQL `SELECT pg_advisory_xact_lock(hashtext(${'epic:' + story.epicId}))`);
            if (oldPriority < position) {
                // Moving down: rows at (oldPriority, position] shift -1
                const affected = await tx
                    .select()
                    .from(stories)
                    .where(and(eq(stories.epicId, story.epicId), gte(stories.priority, oldPriority + 1), lte(stories.priority, position)));
                for (const r of affected) {
                    changes.push({
                        aggregate_id: r.storyId,
                        old_priority: r.priority,
                        new_priority: r.priority - 1,
                    });
                    await tx
                        .update(stories)
                        .set({ priority: r.priority - 1, updatedAt: now })
                        .where(eq(stories.storyId, r.storyId));
                }
            }
            else {
                // Moving up: rows at [position, oldPriority) shift +1
                const affected = await tx
                    .select()
                    .from(stories)
                    .where(and(eq(stories.epicId, story.epicId), gte(stories.priority, position), lte(stories.priority, oldPriority - 1)));
                for (const r of affected) {
                    changes.push({
                        aggregate_id: r.storyId,
                        old_priority: r.priority,
                        new_priority: r.priority + 1,
                    });
                    await tx
                        .update(stories)
                        .set({ priority: r.priority + 1, updatedAt: now })
                        .where(eq(stories.storyId, r.storyId));
                }
            }
            changes.push({
                aggregate_id: storyId,
                old_priority: oldPriority,
                new_priority: position,
            });
            await tx
                .update(stories)
                .set({ priority: position, updatedAt: now })
                .where(eq(stories.storyId, storyId));
        });
        if (changes.length > 0) {
            const ev = {
                aggregate_id: story.epicId,
                aggregate_type: 'epic',
                event_type: 'BacklogReprioritized',
                payload: {
                    scope: 'story',
                    changes,
                    triggered_by: 'user',
                },
                actor,
                trace_id: traceId,
                occurred_at: now.toISOString(),
                schema_version: 1,
            };
            await this.eventStore.append(ev);
        }
    }
    // -------------------------------------------------------------------------
    // Estimation
    // -------------------------------------------------------------------------
    async estimateStory(storyId, storyPoints, rationale, actor = SYSTEM_ACTOR, tenantId = SENTINEL_TENANT) {
        if (!Number.isInteger(storyPoints) || storyPoints <= 0) {
            throw new OrbitalError(BACKLOG_ERROR_CODES.VALIDATION_REQUIRED_FIELD_MISSING, 'story_points must be a positive integer');
        }
        if (!rationale.trim()) {
            throw new OrbitalError(BACKLOG_ERROR_CODES.VALIDATION_REQUIRED_FIELD_MISSING, 'rationale is required');
        }
        const traceId = uuidv7();
        const now = new Date();
        const story = await this.getStory(storyId, tenantId);
        if (!story) {
            throw new OrbitalError(BACKLOG_ERROR_CODES.NOT_FOUND_STORY, `story ${storyId} not found`);
        }
        await this.db
            .update(stories)
            .set({ storyPoints, updatedAt: now })
            .where(and(eq(stories.storyId, storyId), eq(stories.tenantId, tenantId)));
        const ev = {
            aggregate_id: storyId,
            aggregate_type: 'story',
            event_type: 'StoryEstimated',
            payload: {
                story_id: storyId,
                story_points: storyPoints,
                rationale,
            },
            actor,
            trace_id: traceId,
            occurred_at: now.toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(ev);
        return { ...story, storyPoints, updatedAt: now };
    }
    // -------------------------------------------------------------------------
    // Groom (refine + estimate aggregate)
    // -------------------------------------------------------------------------
    async groom(input, actor = SYSTEM_ACTOR, tenantId = SENTINEL_TENANT) {
        const traceId = uuidv7();
        const now = new Date();
        const story = await this.getStory(input.storyId, tenantId);
        if (!story) {
            throw new OrbitalError(BACKLOG_ERROR_CODES.NOT_FOUND_STORY, `story ${input.storyId} not found`);
        }
        const acAdded = [];
        const acRemoved = input.removeAcIds ?? [];
        await this.db.transaction(async (tx) => {
            await tx.execute(dSQL `SELECT pg_advisory_xact_lock(hashtext(${'story:' + input.storyId}))`);
            if (input.descriptionPatch !== undefined) {
                await tx
                    .update(stories)
                    .set({ description: input.descriptionPatch, updatedAt: now })
                    .where(and(eq(stories.storyId, input.storyId), eq(stories.tenantId, tenantId)));
            }
            // Remove ACs by id (only those belonging to this story)
            if (acRemoved.length > 0) {
                await tx
                    .delete(storyAcceptanceCriteria)
                    .where(and(eq(storyAcceptanceCriteria.storyId, input.storyId), inArray(storyAcceptanceCriteria.acId, acRemoved)));
            }
            // Add new ACs
            if (input.addAcs && input.addAcs.length > 0) {
                const existing = await tx
                    .select({ ordinal: storyAcceptanceCriteria.ordinal })
                    .from(storyAcceptanceCriteria)
                    .where(eq(storyAcceptanceCriteria.storyId, input.storyId));
                const maxOrd = existing.reduce((m, r) => Math.max(m, r.ordinal), 0);
                const newRows = input.addAcs.map((text, i) => ({
                    acId: uuidv7(),
                    storyId: input.storyId,
                    ordinal: maxOrd + i + 1,
                    text,
                    verifierHint: null,
                    createdAt: now,
                    schemaVersion: 1,
                }));
                await tx.insert(storyAcceptanceCriteria).values(newRows);
                for (const r of newRows)
                    acAdded.push(r.acId);
            }
            // Estimate
            if (input.storyPoints !== undefined) {
                await tx
                    .update(stories)
                    .set({ storyPoints: input.storyPoints, updatedAt: now })
                    .where(and(eq(stories.storyId, input.storyId), eq(stories.tenantId, tenantId)));
            }
        });
        // Emit StoryRefined
        const refinedEv = {
            aggregate_id: input.storyId,
            aggregate_type: 'story',
            event_type: 'StoryRefined',
            payload: {
                story_id: input.storyId,
                ceremony_id: input.ceremonyId ?? null,
                changes: {
                    ...(input.descriptionPatch !== undefined
                        ? { description: input.descriptionPatch }
                        : {}),
                    ac_added: acAdded,
                    ac_removed: acRemoved,
                    dependencies_added: [],
                },
            },
            actor,
            trace_id: traceId,
            occurred_at: now.toISOString(),
            schema_version: 1,
        };
        await this.eventStore.append(refinedEv);
        // Emit StoryEstimated if applicable
        if (input.storyPoints !== undefined) {
            const estEv = {
                aggregate_id: input.storyId,
                aggregate_type: 'story',
                event_type: 'StoryEstimated',
                payload: {
                    story_id: input.storyId,
                    story_points: input.storyPoints,
                    rationale: input.rationale ?? 'groomed',
                },
                actor,
                trace_id: traceId,
                occurred_at: now.toISOString(),
                schema_version: 1,
            };
            await this.eventStore.append(estEv);
        }
        logger.debug({ storyId: input.storyId, acAdded: acAdded.length, acRemoved: acRemoved.length }, 'BacklogService.groom complete');
        return await this.getStoryRequired(input.storyId, tenantId);
    }
}
// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------
export function createBacklogService(db, eventStore) {
    return new DefaultBacklogService(db, eventStore);
}
//# sourceMappingURL=service.js.map