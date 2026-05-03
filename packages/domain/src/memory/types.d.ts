/**
 * memory/types.ts — Domain types for the project memory subsystem.
 *
 * [Engineer-Sr · Sonnet · run-round6-04-project-memory]
 */
import { z } from 'zod';
export declare const MemoryKindSchema: z.ZodEnum<["decision", "convention", "learning", "anti_pattern", "glossary"]>;
export type MemoryKind = z.infer<typeof MemoryKindSchema>;
export declare const MemorySourceKindSchema: z.ZodEnum<["agent", "operator", "reviewer", "retro", "vision"]>;
export type MemorySourceKind = z.infer<typeof MemorySourceKindSchema>;
export declare const MemoryConfidenceSchema: z.ZodEnum<["low", "medium", "high"]>;
export type MemoryConfidence = z.infer<typeof MemoryConfidenceSchema>;
export declare const MemoryScopeSchema: z.ZodEnum<["project", "feature", "file_pattern"]>;
export type MemoryScope = z.infer<typeof MemoryScopeSchema>;
export declare const MemoryStatusSchema: z.ZodEnum<["active", "archived", "superseded"]>;
export type MemoryStatus = z.infer<typeof MemoryStatusSchema>;
export declare const MemoryLinkKindSchema: z.ZodEnum<["pr", "task", "retro", "vision", "adr"]>;
export type MemoryLinkKind = z.infer<typeof MemoryLinkKindSchema>;
export declare const MemoryLinkSchema: z.ZodObject<{
    linkId: z.ZodString;
    entryId: z.ZodString;
    linkKind: z.ZodEnum<["pr", "task", "retro", "vision", "adr"]>;
    linkValue: z.ZodString;
    createdAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    createdAt: string;
    linkId: string;
    entryId: string;
    linkKind: "task" | "retro" | "adr" | "vision" | "pr";
    linkValue: string;
}, {
    createdAt: string;
    linkId: string;
    entryId: string;
    linkKind: "task" | "retro" | "adr" | "vision" | "pr";
    linkValue: string;
}>;
export type MemoryLink = z.infer<typeof MemoryLinkSchema>;
export declare const MemoryEntrySchema: z.ZodObject<{
    entryId: z.ZodString;
    projectId: z.ZodString;
    kind: z.ZodEnum<["decision", "convention", "learning", "anti_pattern", "glossary"]>;
    title: z.ZodString;
    body: z.ZodString;
    sourceKind: z.ZodEnum<["agent", "operator", "reviewer", "retro", "vision"]>;
    sourceId: z.ZodNullable<z.ZodString>;
    confidence: z.ZodEnum<["low", "medium", "high"]>;
    scope: z.ZodEnum<["project", "feature", "file_pattern"]>;
    scopeValue: z.ZodNullable<z.ZodString>;
    status: z.ZodEnum<["active", "archived", "superseded"]>;
    supersededBy: z.ZodNullable<z.ZodString>;
    tags: z.ZodArray<z.ZodString, "many">;
    links: z.ZodArray<z.ZodObject<{
        linkId: z.ZodString;
        entryId: z.ZodString;
        linkKind: z.ZodEnum<["pr", "task", "retro", "vision", "adr"]>;
        linkValue: z.ZodString;
        createdAt: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        createdAt: string;
        linkId: string;
        entryId: string;
        linkKind: "task" | "retro" | "adr" | "vision" | "pr";
        linkValue: string;
    }, {
        createdAt: string;
        linkId: string;
        entryId: string;
        linkKind: "task" | "retro" | "adr" | "vision" | "pr";
        linkValue: string;
    }>, "many">;
    createdAt: z.ZodString;
    updatedAt: z.ZodString;
}, "strip", z.ZodTypeAny, {
    status: "active" | "archived" | "superseded";
    tags: string[];
    body: string;
    title: string;
    scope: "project" | "feature" | "file_pattern";
    confidence: "low" | "medium" | "high";
    kind: "decision" | "convention" | "learning" | "anti_pattern" | "glossary";
    createdAt: string;
    entryId: string;
    projectId: string;
    sourceKind: "retro" | "agent" | "operator" | "reviewer" | "vision";
    sourceId: string | null;
    scopeValue: string | null;
    supersededBy: string | null;
    links: {
        createdAt: string;
        linkId: string;
        entryId: string;
        linkKind: "task" | "retro" | "adr" | "vision" | "pr";
        linkValue: string;
    }[];
    updatedAt: string;
}, {
    status: "active" | "archived" | "superseded";
    tags: string[];
    body: string;
    title: string;
    scope: "project" | "feature" | "file_pattern";
    confidence: "low" | "medium" | "high";
    kind: "decision" | "convention" | "learning" | "anti_pattern" | "glossary";
    createdAt: string;
    entryId: string;
    projectId: string;
    sourceKind: "retro" | "agent" | "operator" | "reviewer" | "vision";
    sourceId: string | null;
    scopeValue: string | null;
    supersededBy: string | null;
    links: {
        createdAt: string;
        linkId: string;
        entryId: string;
        linkKind: "task" | "retro" | "adr" | "vision" | "pr";
        linkValue: string;
    }[];
    updatedAt: string;
}>;
export type MemoryEntry = z.infer<typeof MemoryEntrySchema>;
export declare const CreateMemoryEntryInputSchema: z.ZodObject<{
    projectId: z.ZodString;
    kind: z.ZodEnum<["decision", "convention", "learning", "anti_pattern", "glossary"]>;
    title: z.ZodString;
    body: z.ZodString;
    sourceKind: z.ZodEnum<["agent", "operator", "reviewer", "retro", "vision"]>;
    sourceId: z.ZodOptional<z.ZodString>;
    confidence: z.ZodDefault<z.ZodEnum<["low", "medium", "high"]>>;
    scope: z.ZodDefault<z.ZodEnum<["project", "feature", "file_pattern"]>>;
    scopeValue: z.ZodOptional<z.ZodString>;
    tags: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    links: z.ZodDefault<z.ZodArray<z.ZodObject<{
        linkKind: z.ZodEnum<["pr", "task", "retro", "vision", "adr"]>;
        linkValue: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        linkKind: "task" | "retro" | "adr" | "vision" | "pr";
        linkValue: string;
    }, {
        linkKind: "task" | "retro" | "adr" | "vision" | "pr";
        linkValue: string;
    }>, "many">>;
}, "strip", z.ZodTypeAny, {
    tags: string[];
    body: string;
    title: string;
    scope: "project" | "feature" | "file_pattern";
    confidence: "low" | "medium" | "high";
    kind: "decision" | "convention" | "learning" | "anti_pattern" | "glossary";
    projectId: string;
    sourceKind: "retro" | "agent" | "operator" | "reviewer" | "vision";
    links: {
        linkKind: "task" | "retro" | "adr" | "vision" | "pr";
        linkValue: string;
    }[];
    sourceId?: string | undefined;
    scopeValue?: string | undefined;
}, {
    body: string;
    title: string;
    kind: "decision" | "convention" | "learning" | "anti_pattern" | "glossary";
    projectId: string;
    sourceKind: "retro" | "agent" | "operator" | "reviewer" | "vision";
    tags?: string[] | undefined;
    scope?: "project" | "feature" | "file_pattern" | undefined;
    confidence?: "low" | "medium" | "high" | undefined;
    sourceId?: string | undefined;
    scopeValue?: string | undefined;
    links?: {
        linkKind: "task" | "retro" | "adr" | "vision" | "pr";
        linkValue: string;
    }[] | undefined;
}>;
export type CreateMemoryEntryInput = z.infer<typeof CreateMemoryEntryInputSchema>;
export declare const UpdateMemoryEntryInputSchema: z.ZodObject<{
    entryId: z.ZodString;
    title: z.ZodOptional<z.ZodString>;
    body: z.ZodOptional<z.ZodString>;
    confidence: z.ZodOptional<z.ZodEnum<["low", "medium", "high"]>>;
    scope: z.ZodOptional<z.ZodEnum<["project", "feature", "file_pattern"]>>;
    scopeValue: z.ZodOptional<z.ZodString>;
    tags: z.ZodOptional<z.ZodArray<z.ZodString, "many">>;
}, "strip", z.ZodTypeAny, {
    entryId: string;
    tags?: string[] | undefined;
    body?: string | undefined;
    title?: string | undefined;
    scope?: "project" | "feature" | "file_pattern" | undefined;
    confidence?: "low" | "medium" | "high" | undefined;
    scopeValue?: string | undefined;
}, {
    entryId: string;
    tags?: string[] | undefined;
    body?: string | undefined;
    title?: string | undefined;
    scope?: "project" | "feature" | "file_pattern" | undefined;
    confidence?: "low" | "medium" | "high" | undefined;
    scopeValue?: string | undefined;
}>;
export type UpdateMemoryEntryInput = z.infer<typeof UpdateMemoryEntryInputSchema>;
export declare const ArchiveMemoryEntryInputSchema: z.ZodObject<{
    entryId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    entryId: string;
}, {
    entryId: string;
}>;
export declare const SupersedeMemoryEntryInputSchema: z.ZodObject<{
    entryId: z.ZodString;
    supersededByEntryId: z.ZodString;
}, "strip", z.ZodTypeAny, {
    entryId: string;
    supersededByEntryId: string;
}, {
    entryId: string;
    supersededByEntryId: string;
}>;
export declare const ListMemoryEntriesInputSchema: z.ZodObject<{
    projectId: z.ZodString;
    kind: z.ZodOptional<z.ZodEnum<["decision", "convention", "learning", "anti_pattern", "glossary"]>>;
    scope: z.ZodOptional<z.ZodEnum<["project", "feature", "file_pattern"]>>;
    status: z.ZodDefault<z.ZodEnum<["active", "archived", "superseded"]>>;
    sourceKind: z.ZodOptional<z.ZodEnum<["agent", "operator", "reviewer", "retro", "vision"]>>;
    /** Free-text search (title + body match) */
    search: z.ZodOptional<z.ZodString>;
    /** Tag filter — entries must have ALL of these tags */
    tags: z.ZodDefault<z.ZodArray<z.ZodString, "many">>;
    limit: z.ZodDefault<z.ZodNumber>;
    offset: z.ZodDefault<z.ZodNumber>;
}, "strip", z.ZodTypeAny, {
    limit: number;
    offset: number;
    status: "active" | "archived" | "superseded";
    tags: string[];
    projectId: string;
    search?: string | undefined;
    scope?: "project" | "feature" | "file_pattern" | undefined;
    kind?: "decision" | "convention" | "learning" | "anti_pattern" | "glossary" | undefined;
    sourceKind?: "retro" | "agent" | "operator" | "reviewer" | "vision" | undefined;
}, {
    projectId: string;
    search?: string | undefined;
    limit?: number | undefined;
    offset?: number | undefined;
    status?: "active" | "archived" | "superseded" | undefined;
    tags?: string[] | undefined;
    scope?: "project" | "feature" | "file_pattern" | undefined;
    kind?: "decision" | "convention" | "learning" | "anti_pattern" | "glossary" | undefined;
    sourceKind?: "retro" | "agent" | "operator" | "reviewer" | "vision" | undefined;
}>;
export type ListMemoryEntriesInput = z.infer<typeof ListMemoryEntriesInputSchema>;
export declare const SearchMemoryInputSchema: z.ZodObject<{
    projectId: z.ZodString;
    query: z.ZodString;
    k: z.ZodDefault<z.ZodNumber>;
    filter: z.ZodOptional<z.ZodObject<{
        kind: z.ZodOptional<z.ZodEnum<["decision", "convention", "learning", "anti_pattern", "glossary"]>>;
        scope: z.ZodOptional<z.ZodEnum<["project", "feature", "file_pattern"]>>;
    }, "strip", z.ZodTypeAny, {
        scope?: "project" | "feature" | "file_pattern" | undefined;
        kind?: "decision" | "convention" | "learning" | "anti_pattern" | "glossary" | undefined;
    }, {
        scope?: "project" | "feature" | "file_pattern" | undefined;
        kind?: "decision" | "convention" | "learning" | "anti_pattern" | "glossary" | undefined;
    }>>;
}, "strip", z.ZodTypeAny, {
    query: string;
    projectId: string;
    k: number;
    filter?: {
        scope?: "project" | "feature" | "file_pattern" | undefined;
        kind?: "decision" | "convention" | "learning" | "anti_pattern" | "glossary" | undefined;
    } | undefined;
}, {
    query: string;
    projectId: string;
    filter?: {
        scope?: "project" | "feature" | "file_pattern" | undefined;
        kind?: "decision" | "convention" | "learning" | "anti_pattern" | "glossary" | undefined;
    } | undefined;
    k?: number | undefined;
}>;
export type SearchMemoryInput = z.infer<typeof SearchMemoryInputSchema>;
export interface MemoryEntryRecordedPayload {
    entry_id: string;
    project_id: string;
    kind: MemoryKind;
    title: string;
    source_kind: MemorySourceKind;
    source_id: string | null;
    tags: string[];
}
export interface MemoryEntryCuratedPayload {
    entry_id: string;
    project_id: string;
    field_changed: string;
    old_value?: unknown;
    new_value?: unknown;
}
export interface MemoryEntryArchivedPayload {
    entry_id: string;
    project_id: string;
}
export interface MemoryRetrievedForBriefPayload {
    task_id: string;
    project_id: string;
    entry_ids: string[];
    retrieval_method: 'vector' | 'tag_fallback' | 'none';
    k: number;
}
//# sourceMappingURL=types.d.ts.map