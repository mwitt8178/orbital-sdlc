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
import { type Actor } from '@orbital/types';
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import { type EpicRow, type StoryRow, type StoryAcceptanceCriterionRow, type StoryStatus } from '@orbital/db';
import { type CreateEpicInput, type CreateStoryInput, type UpdateStoryInput } from './types.js';
export interface StoryWithAcceptanceCriteria extends StoryRow {
    acceptanceCriteria: StoryAcceptanceCriterionRow[];
}
export interface BacklogService {
    createEpic(input: CreateEpicInput, actor?: Actor, tenantId?: string): Promise<EpicRow>;
    listEpics(filter?: {
        status?: StoryStatus | string;
        visionVersionId?: string;
    }, tenantId?: string): Promise<EpicRow[]>;
    getEpic(epicId: string, tenantId?: string): Promise<EpicRow | null>;
    createStory(input: CreateStoryInput, actor?: Actor, tenantId?: string): Promise<StoryWithAcceptanceCriteria>;
    listStories(filter?: {
        epicId?: string;
        status?: StoryStatus;
        sprintId?: string;
    }, tenantId?: string): Promise<StoryRow[]>;
    getStory(storyId: string, tenantId?: string): Promise<StoryWithAcceptanceCriteria | null>;
    updateStory(input: UpdateStoryInput, actor?: Actor, tenantId?: string): Promise<StoryWithAcceptanceCriteria>;
    movStoryToPosition(storyId: string, position: number, actor?: Actor, tenantId?: string): Promise<void>;
    estimateStory(storyId: string, storyPoints: number, rationale: string, actor?: Actor, tenantId?: string): Promise<StoryRow>;
    groom(input: {
        storyId: string;
        descriptionPatch?: string;
        addAcs?: string[];
        removeAcIds?: string[];
        storyPoints?: number;
        rationale?: string;
        ceremonyId?: string;
    }, actor?: Actor, tenantId?: string): Promise<StoryWithAcceptanceCriteria>;
}
export declare class DefaultBacklogService implements BacklogService {
    private readonly db;
    private readonly eventStore;
    constructor(db: DB, eventStore: EventStore);
    createEpic(input: CreateEpicInput, actor?: Actor, tenantId?: string): Promise<EpicRow>;
    listEpics(filter?: {
        status?: string;
        visionVersionId?: string;
    }, tenantId?: string): Promise<EpicRow[]>;
    getEpic(epicId: string, tenantId?: string): Promise<EpicRow | null>;
    createStory(input: CreateStoryInput, actor?: Actor, tenantId?: string): Promise<StoryWithAcceptanceCriteria>;
    listStories(filter?: {
        epicId?: string;
        status?: StoryStatus;
        sprintId?: string;
    }, tenantId?: string): Promise<StoryRow[]>;
    getStory(storyId: string, tenantId?: string): Promise<StoryWithAcceptanceCriteria | null>;
    private getStoryRequired;
    updateStory(input: UpdateStoryInput, actor?: Actor, tenantId?: string): Promise<StoryWithAcceptanceCriteria>;
    private linkedArtifactRequirement;
    movStoryToPosition(storyId: string, position: number, actor?: Actor, tenantId?: string): Promise<void>;
    estimateStory(storyId: string, storyPoints: number, rationale: string, actor?: Actor, tenantId?: string): Promise<StoryRow>;
    groom(input: {
        storyId: string;
        descriptionPatch?: string;
        addAcs?: string[];
        removeAcIds?: string[];
        storyPoints?: number;
        rationale?: string;
        ceremonyId?: string;
    }, actor?: Actor, tenantId?: string): Promise<StoryWithAcceptanceCriteria>;
}
export declare function createBacklogService(db: DB, eventStore: EventStore): BacklogService;
//# sourceMappingURL=service.d.ts.map