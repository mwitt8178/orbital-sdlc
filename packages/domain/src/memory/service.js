/**
 * memory/service.ts — MemoryService: CRUD for project memory entries.
 *
 * [Engineer-Sr · Sonnet · run-round6-04-project-memory]
 *
 * Agents call this service through the MCP memory.record / memory.search tools.
 * Operators call it through the tRPC memory router.
 *
 * All writes emit events through EventStore for the audit trail:
 *   MemoryEntryRecorded   — new entry created
 *   MemoryEntryCurated    — field updated by operator
 *   MemoryEntryArchived   — entry archived
 */
import { uuidv7 } from 'uuidv7';
import { eq, and, inArray, ilike, or, sql as dSQL } from 'drizzle-orm';
const SENTINEL_TENANT = '00000000-0000-0000-0000-000000000000';
import { OrbitalError } from '@orbital/types';
import { projectMemoryEntries, projectMemoryTags, projectMemoryLinks, } from '@orbital/db';
import { logger } from '../logger.js';
// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------
export class DefaultMemoryService {
    db;
    eventStore;
    constructor(db, eventStore) {
        this.db = db;
        this.eventStore = eventStore;
    }
    async record(input, actorId, tenantId = SENTINEL_TENANT) {
        const entryId = uuidv7();
        const now = new Date();
        await this.db.insert(projectMemoryEntries).values({
            entryId,
            tenantId,
            projectId: input.projectId,
            kind: input.kind,
            title: input.title,
            body: input.body,
            sourceKind: input.sourceKind,
            sourceId: input.sourceId ?? null,
            confidence: input.confidence,
            scope: input.scope,
            scopeValue: input.scopeValue ?? null,
            status: 'active',
            supersededBy: null,
            embedding: null,
            createdAt: now,
            updatedAt: now,
        });
        // Insert tags
        if (input.tags.length > 0) {
            await this.db.insert(projectMemoryTags).values(input.tags.map((tag) => ({ entryId, tag })));
        }
        // Insert links
        if (input.links.length > 0) {
            await this.db.insert(projectMemoryLinks).values(input.links.map((l) => ({
                linkId: uuidv7(),
                entryId,
                linkKind: l.linkKind,
                linkValue: l.linkValue,
                createdAt: now,
            })));
        }
        // Emit event
        const payload = {
            entry_id: entryId,
            project_id: input.projectId,
            kind: input.kind,
            title: input.title,
            source_kind: input.sourceKind,
            source_id: input.sourceId ?? null,
            tags: input.tags,
        };
        await this.eventStore.append({
            aggregate_id: input.projectId,
            aggregate_type: 'orchestration',
            event_type: 'MemoryEntryRecorded',
            payload: payload,
            actor: { type: 'system', component: 'orchestrator' },
            trace_id: uuidv7(),
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        });
        logger.info({ entryId, projectId: input.projectId, kind: input.kind }, 'memory: entry recorded');
        return this.get(entryId);
    }
    async update(input, actorId, tenantId = SENTINEL_TENANT) {
        const existing = await this.get(input.entryId, tenantId);
        const updates = { updatedAt: new Date() };
        const changes = [];
        if (input.title !== undefined && input.title !== existing.title) {
            changes.push({ field: 'title', oldVal: existing.title, newVal: input.title });
            updates['title'] = input.title;
        }
        if (input.body !== undefined && input.body !== existing.body) {
            changes.push({ field: 'body', oldVal: '[old body]', newVal: '[new body]' });
            updates['body'] = input.body;
        }
        if (input.confidence !== undefined && input.confidence !== existing.confidence) {
            changes.push({ field: 'confidence', oldVal: existing.confidence, newVal: input.confidence });
            updates['confidence'] = input.confidence;
        }
        if (input.scope !== undefined && input.scope !== existing.scope) {
            changes.push({ field: 'scope', oldVal: existing.scope, newVal: input.scope });
            updates['scope'] = input.scope;
        }
        if (input.scopeValue !== undefined && input.scopeValue !== existing.scopeValue) {
            changes.push({ field: 'scope_value', oldVal: existing.scopeValue, newVal: input.scopeValue });
            updates['scopeValue'] = input.scopeValue;
        }
        if (Object.keys(updates).length > 1) {
            await this.db
                .update(projectMemoryEntries)
                .set(updates)
                .where(eq(projectMemoryEntries.entryId, input.entryId));
        }
        // Update tags if provided
        if (input.tags !== undefined) {
            await this.db
                .delete(projectMemoryTags)
                .where(eq(projectMemoryTags.entryId, input.entryId));
            if (input.tags.length > 0) {
                await this.db.insert(projectMemoryTags).values(input.tags.map((tag) => ({ entryId: input.entryId, tag })));
            }
            changes.push({ field: 'tags', oldVal: existing.tags, newVal: input.tags });
        }
        // Emit curated event for each changed field
        for (const change of changes) {
            const payload = {
                entry_id: input.entryId,
                project_id: existing.projectId,
                field_changed: change.field,
                old_value: change.oldVal,
                new_value: change.newVal,
            };
            await this.eventStore.append({
                aggregate_id: existing.projectId,
                aggregate_type: 'orchestration',
                event_type: 'MemoryEntryCurated',
                payload: payload,
                actor: { type: 'system', component: 'orchestrator' },
                trace_id: uuidv7(),
                occurred_at: new Date().toISOString(),
                schema_version: 1,
            });
        }
        logger.info({ entryId: input.entryId, changes: changes.length }, 'memory: entry curated');
        return this.get(input.entryId);
    }
    async archive(entryId, actorId, tenantId = SENTINEL_TENANT) {
        const existing = await this.get(entryId, tenantId);
        await this.db
            .update(projectMemoryEntries)
            .set({ status: 'archived', updatedAt: new Date() })
            .where(and(eq(projectMemoryEntries.entryId, entryId), eq(projectMemoryEntries.tenantId, tenantId)));
        const payload = {
            entry_id: entryId,
            project_id: existing.projectId,
        };
        await this.eventStore.append({
            aggregate_id: existing.projectId,
            aggregate_type: 'orchestration',
            event_type: 'MemoryEntryArchived',
            payload: payload,
            actor: { type: 'system', component: 'orchestrator' },
            trace_id: uuidv7(),
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        });
        logger.info({ entryId, projectId: existing.projectId }, 'memory: entry archived');
    }
    async supersede(entryId, supersededByEntryId, actorId, tenantId = SENTINEL_TENANT) {
        const existing = await this.get(entryId, tenantId);
        // Verify the superseding entry exists (same tenant scope)
        await this.get(supersededByEntryId, tenantId);
        await this.db
            .update(projectMemoryEntries)
            .set({ status: 'superseded', supersededBy: supersededByEntryId, updatedAt: new Date() })
            .where(and(eq(projectMemoryEntries.entryId, entryId), eq(projectMemoryEntries.tenantId, tenantId)));
        const payload = {
            entry_id: entryId,
            project_id: existing.projectId,
            field_changed: 'status',
            old_value: 'active',
            new_value: 'superseded',
        };
        await this.eventStore.append({
            aggregate_id: existing.projectId,
            aggregate_type: 'orchestration',
            event_type: 'MemoryEntryCurated',
            payload: payload,
            actor: { type: 'system', component: 'orchestrator' },
            trace_id: uuidv7(),
            occurred_at: new Date().toISOString(),
            schema_version: 1,
        });
        logger.info({ entryId, supersededByEntryId }, 'memory: entry superseded');
    }
    async get(entryId, tenantId = SENTINEL_TENANT) {
        const rows = await this.db
            .select()
            .from(projectMemoryEntries)
            .where(and(eq(projectMemoryEntries.entryId, entryId), eq(projectMemoryEntries.tenantId, tenantId)))
            .limit(1);
        const row = rows[0];
        if (!row) {
            throw new OrbitalError('NOT_FOUND_MEMORY_ENTRY', `Memory entry ${entryId} not found.`, { entry_id: entryId }, 'no_retry');
        }
        const [tags, links] = await Promise.all([
            this.db
                .select()
                .from(projectMemoryTags)
                .where(eq(projectMemoryTags.entryId, entryId)),
            this.db
                .select()
                .from(projectMemoryLinks)
                .where(eq(projectMemoryLinks.entryId, entryId)),
        ]);
        return {
            entryId: row.entryId,
            projectId: row.projectId,
            kind: row.kind,
            title: row.title,
            body: row.body,
            sourceKind: row.sourceKind,
            sourceId: row.sourceId ?? null,
            confidence: row.confidence,
            scope: row.scope,
            scopeValue: row.scopeValue ?? null,
            status: row.status,
            supersededBy: row.supersededBy ?? null,
            tags: tags.map((t) => t.tag),
            links: links.map((l) => ({
                linkId: l.linkId,
                entryId: l.entryId,
                linkKind: l.linkKind,
                linkValue: l.linkValue,
                createdAt: l.createdAt.toISOString(),
            })),
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        };
    }
    async list(input, tenantId = SENTINEL_TENANT) {
        const conditions = [
            eq(projectMemoryEntries.tenantId, tenantId),
            eq(projectMemoryEntries.projectId, input.projectId),
            eq(projectMemoryEntries.status, input.status),
        ];
        if (input.kind) {
            conditions.push(eq(projectMemoryEntries.kind, input.kind));
        }
        if (input.scope) {
            conditions.push(eq(projectMemoryEntries.scope, input.scope));
        }
        if (input.sourceKind) {
            conditions.push(eq(projectMemoryEntries.sourceKind, input.sourceKind));
        }
        if (input.search) {
            conditions.push(or(ilike(projectMemoryEntries.title, `%${input.search}%`), ilike(projectMemoryEntries.body, `%${input.search}%`)));
        }
        const where = and(...conditions);
        // If tag filter requested, find entry IDs matching ALL tags
        let tagFilteredIds = null;
        if (input.tags.length > 0) {
            // Entries that have ALL of the requested tags (GROUP BY + HAVING COUNT = n)
            const tagRows = await this.db
                .select({ entryId: projectMemoryTags.entryId })
                .from(projectMemoryTags)
                .where(inArray(projectMemoryTags.tag, input.tags))
                .groupBy(projectMemoryTags.entryId)
                .having(dSQL `count(distinct ${projectMemoryTags.tag}) = ${input.tags.length}`);
            tagFilteredIds = tagRows.map((r) => r.entryId);
            if (tagFilteredIds.length === 0) {
                return { entries: [], total: 0 };
            }
        }
        const finalConditions = tagFilteredIds
            ? [where, inArray(projectMemoryEntries.entryId, tagFilteredIds)]
            : [where];
        const finalWhere = and(...finalConditions.filter(Boolean));
        const [rows, countRows] = await Promise.all([
            this.db
                .select()
                .from(projectMemoryEntries)
                .where(finalWhere)
                .orderBy(projectMemoryEntries.createdAt)
                .limit(input.limit)
                .offset(input.offset),
            this.db
                .select({ count: dSQL `count(*)::int` })
                .from(projectMemoryEntries)
                .where(finalWhere),
        ]);
        const total = countRows[0]?.count ?? 0;
        // Batch load tags + links
        const entryIds = rows.map((r) => r.entryId);
        const [allTags, allLinks] = entryIds.length === 0
            ? [[], []]
            : await Promise.all([
                this.db
                    .select()
                    .from(projectMemoryTags)
                    .where(inArray(projectMemoryTags.entryId, entryIds)),
                this.db
                    .select()
                    .from(projectMemoryLinks)
                    .where(inArray(projectMemoryLinks.entryId, entryIds)),
            ]);
        const tagsByEntry = new Map();
        for (const t of allTags) {
            if (!tagsByEntry.has(t.entryId))
                tagsByEntry.set(t.entryId, []);
            tagsByEntry.get(t.entryId).push(t.tag);
        }
        const linksByEntry = new Map();
        for (const l of allLinks) {
            if (!linksByEntry.has(l.entryId))
                linksByEntry.set(l.entryId, []);
            linksByEntry.get(l.entryId).push(l);
        }
        const entries = rows.map((row) => ({
            entryId: row.entryId,
            projectId: row.projectId,
            kind: row.kind,
            title: row.title,
            body: row.body,
            sourceKind: row.sourceKind,
            sourceId: row.sourceId ?? null,
            confidence: row.confidence,
            scope: row.scope,
            scopeValue: row.scopeValue ?? null,
            status: row.status,
            supersededBy: row.supersededBy ?? null,
            tags: tagsByEntry.get(row.entryId) ?? [],
            links: (linksByEntry.get(row.entryId) ?? []).map((l) => ({
                linkId: l.linkId,
                entryId: l.entryId,
                linkKind: l.linkKind,
                linkValue: l.linkValue,
                createdAt: l.createdAt.toISOString(),
            })),
            createdAt: row.createdAt.toISOString(),
            updatedAt: row.updatedAt.toISOString(),
        }));
        return { entries, total };
    }
}
export function createMemoryService(db, eventStore) {
    return new DefaultMemoryService(db, eventStore);
}
//# sourceMappingURL=service.js.map