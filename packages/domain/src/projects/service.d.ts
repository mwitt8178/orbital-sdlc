/**
 * projects/service.ts — ProjectsService.
 *
 * Per Round 4 Projects Feature spec.
 *
 * Responsibilities:
 *   - Project CRUD (create, list, get, update, archive)
 *   - Connect Monday board (validates board exists via MondayClient)
 *   - Connect Github repo (validates repo exists via GithubClient)
 *   - Bootstrap a "Default Project" on first boot for back-compat
 *
 * All mutations:
 *   1. Validate via Zod
 *   2. Mutate row
 *   3. Append event via EventStore (never raw db.insert(events))
 */
import { type Actor } from '@orbital/types';
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import { type ProjectRow } from '@orbital/db';
import { type CreateProjectInput, type UpdateProjectInput, type ConnectMondayInput, type ConnectGithubInput } from './types.js';
import type { MondayClient } from '../backlog/monday-client.js';
import type { GithubClient } from '../../../orchestrator/src/github/client.js';
export interface ProjectsService {
    create(input: CreateProjectInput, actor?: Actor, tenantId?: string): Promise<ProjectRow>;
    list(filter?: {
        archived?: boolean;
    }, tenantId?: string): Promise<ProjectRow[]>;
    get(projectId: string, tenantId?: string): Promise<ProjectRow | null>;
    getBySlug(slug: string, installId: string): Promise<ProjectRow | null>;
    update(input: UpdateProjectInput, actor?: Actor, tenantId?: string): Promise<ProjectRow>;
    archive(projectId: string, actor?: Actor, tenantId?: string): Promise<void>;
    connectMonday(input: ConnectMondayInput, actor?: Actor, tenantId?: string): Promise<ProjectRow>;
    connectGithub(input: ConnectGithubInput, actor?: Actor, tenantId?: string): Promise<ProjectRow>;
    /**
     * On boot: ensures a "Default Project" row exists for the current install
     * and backfills any aggregate rows that have project_id IS NULL. Idempotent.
     */
    ensureDefaultProject(): Promise<ProjectRow>;
}
export declare class DefaultProjectsService implements ProjectsService {
    private readonly db;
    private readonly eventStore;
    private readonly mondayClient;
    private readonly githubClient;
    constructor(db: DB, eventStore: EventStore, mondayClient?: MondayClient | null, githubClient?: GithubClient | null);
    create(input: CreateProjectInput, actor?: Actor, tenantId?: string): Promise<ProjectRow>;
    list(filter?: {
        archived?: boolean;
    }, tenantId?: string): Promise<ProjectRow[]>;
    get(projectId: string, tenantId?: string): Promise<ProjectRow | null>;
    getBySlug(slug: string, installId: string): Promise<ProjectRow | null>;
    update(input: UpdateProjectInput, actor?: Actor, tenantId?: string): Promise<ProjectRow>;
    archive(projectId: string, actor?: Actor, tenantId?: string): Promise<void>;
    connectMonday(input: ConnectMondayInput, actor?: Actor, tenantId?: string): Promise<ProjectRow>;
    connectGithub(input: ConnectGithubInput, actor?: Actor, tenantId?: string): Promise<ProjectRow>;
    ensureDefaultProject(): Promise<ProjectRow>;
    private backfillExistingRows;
}
export declare function createProjectsService(db: DB, eventStore: EventStore, options?: {
    mondayClient?: MondayClient | null;
    githubClient?: GithubClient | null;
}): ProjectsService;
//# sourceMappingURL=service.d.ts.map