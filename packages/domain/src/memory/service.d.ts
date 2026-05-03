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
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import type { MemoryEntry, CreateMemoryEntryInput, UpdateMemoryEntryInput, ListMemoryEntriesInput } from './types.js';
export interface MemoryService {
    record(input: CreateMemoryEntryInput, actorId: string, tenantId?: string): Promise<MemoryEntry>;
    update(input: UpdateMemoryEntryInput, actorId: string, tenantId?: string): Promise<MemoryEntry>;
    archive(entryId: string, actorId: string, tenantId?: string): Promise<void>;
    supersede(entryId: string, supersededByEntryId: string, actorId: string, tenantId?: string): Promise<void>;
    get(entryId: string, tenantId?: string): Promise<MemoryEntry>;
    list(input: ListMemoryEntriesInput, tenantId?: string): Promise<{
        entries: MemoryEntry[];
        total: number;
    }>;
}
export declare class DefaultMemoryService implements MemoryService {
    private readonly db;
    private readonly eventStore;
    constructor(db: DB, eventStore: EventStore);
    record(input: CreateMemoryEntryInput, actorId: string, tenantId?: string): Promise<MemoryEntry>;
    update(input: UpdateMemoryEntryInput, actorId: string, tenantId?: string): Promise<MemoryEntry>;
    archive(entryId: string, actorId: string, tenantId?: string): Promise<void>;
    supersede(entryId: string, supersededByEntryId: string, actorId: string, tenantId?: string): Promise<void>;
    get(entryId: string, tenantId?: string): Promise<MemoryEntry>;
    list(input: ListMemoryEntriesInput, tenantId?: string): Promise<{
        entries: MemoryEntry[];
        total: number;
    }>;
}
export declare function createMemoryService(db: DB, eventStore: EventStore): MemoryService;
//# sourceMappingURL=service.d.ts.map