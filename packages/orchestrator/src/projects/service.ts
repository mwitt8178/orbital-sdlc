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

import { uuidv7 } from 'uuidv7'
import { eq, and, asc, isNull, sql as drizzleSql } from 'drizzle-orm'

const SENTINEL_TENANT = '00000000-0000-0000-0000-000000000000'
import { OrbitalError, type Actor, type EventInput } from '@orbital/types'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { projects, type ProjectRow } from '../db/schema/projects.js'
import { logger } from '../config/logger.js'
import { loadOrCreateInstall } from '../config/install.js'
import {
  CreateProjectInputSchema,
  UpdateProjectInputSchema,
  ConnectMondayInputSchema,
  ConnectGithubInputSchema,
  PROJECTS_ERROR_CODES,
  type CreateProjectInput,
  type UpdateProjectInput,
  type ConnectMondayInput,
  type ConnectGithubInput,
} from './types.js'
import type { MondayClient } from '../backlog/monday-client.js'
import type { GithubClient } from '../github/client.js'

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface ProjectsService {
  create(input: CreateProjectInput, actor?: Actor, tenantId?: string): Promise<ProjectRow>
  list(filter?: { archived?: boolean }, tenantId?: string): Promise<ProjectRow[]>
  get(projectId: string, tenantId?: string): Promise<ProjectRow | null>
  getBySlug(slug: string, installId: string): Promise<ProjectRow | null>
  update(input: UpdateProjectInput, actor?: Actor, tenantId?: string): Promise<ProjectRow>
  archive(projectId: string, actor?: Actor, tenantId?: string): Promise<void>
  connectMonday(input: ConnectMondayInput, actor?: Actor, tenantId?: string): Promise<ProjectRow>
  connectGithub(input: ConnectGithubInput, actor?: Actor, tenantId?: string): Promise<ProjectRow>
  /**
   * On boot: ensures a "Default Project" row exists for the current install
   * and backfills any aggregate rows that have project_id IS NULL. Idempotent.
   */
  ensureDefaultProject(): Promise<ProjectRow>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_PROJECT_SLUG = 'default'
const DEFAULT_PROJECT_NAME = 'Default Project'
const DEFAULT_BRANCH = 'main'

export class DefaultProjectsService implements ProjectsService {
  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
    private readonly mondayClient: MondayClient | null = null,
    private readonly githubClient: GithubClient | null = null,
  ) {}

  // -------------------------------------------------------------------------
  // create
  // -------------------------------------------------------------------------

  async create(
    input: CreateProjectInput,
    actor: Actor = SYSTEM_ACTOR,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<ProjectRow> {
    const parsed = CreateProjectInputSchema.parse(input)
    const install = await loadOrCreateInstall()
    const installId = install.install_id

    // Slug uniqueness pre-check (the unique index is the authoritative
    // gate; this is a friendlier error path before the insert runs)
    const existing = await this.getBySlug(parsed.slug, installId)
    if (existing) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.CONFLICT_SLUG,
        `slug '${parsed.slug}' already in use within install`,
        { slug: parsed.slug },
      )
    }

    const projectId = uuidv7()
    const traceId = uuidv7()
    const now = new Date()

    let row: ProjectRow | undefined
    try {
      const inserted = await this.db
        .insert(projects)
        .values({
          projectId,
          tenantId,
          installId,
          name: parsed.name,
          slug: parsed.slug,
          description: parsed.description ?? null,
          mondayBoardId: parsed.mondayBoardId ?? null,
          githubOwner: parsed.githubOwner ?? null,
          githubRepo: parsed.githubRepo ?? null,
          githubDefaultBranch: parsed.githubDefaultBranch ?? DEFAULT_BRANCH,
          archivedAt: null,
          createdByEventId: null,
          createdAt: now,
          updatedAt: now,
          schemaVersion: 1,
        })
        .returning()
      row = inserted[0]
    } catch (err) {
      // Race between getBySlug and insert: surface as CONFLICT_SLUG.
      const msg = (err as Error).message ?? ''
      if (msg.includes('projects_install_slug_uq') || msg.includes('duplicate key')) {
        throw new OrbitalError(
          PROJECTS_ERROR_CODES.CONFLICT_SLUG,
          `slug '${parsed.slug}' already in use within install`,
          { slug: parsed.slug },
        )
      }
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.INTERNAL_DB_ERROR,
        `INSERT project failed: ${msg}`,
      )
    }

    if (!row) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.INTERNAL_DB_ERROR,
        'INSERT project returned no rows',
      )
    }

    const ev: EventInput = {
      aggregate_id: projectId,
      aggregate_type: 'install',
      event_type: 'ProjectCreated',
      payload: {
        project_id: projectId,
        install_id: installId,
        name: parsed.name,
        slug: parsed.slug,
        description: parsed.description ?? null,
        monday_board_id: parsed.mondayBoardId ?? null,
        github_owner: parsed.githubOwner ?? null,
        github_repo: parsed.githubRepo ?? null,
        github_default_branch: parsed.githubDefaultBranch ?? DEFAULT_BRANCH,
      },
      actor,
      trace_id: traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    const envelope = await this.eventStore.append(ev)

    // Patch the created_by_event_id in-place (best-effort, idempotent)
    await this.db
      .update(projects)
      .set({ createdByEventId: envelope.event_id })
      .where(eq(projects.projectId, projectId))

    return { ...row, createdByEventId: envelope.event_id }
  }

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  async list(
    filter: { archived?: boolean } = {},
    tenantId: string = SENTINEL_TENANT,
  ): Promise<ProjectRow[]> {
    const install = await loadOrCreateInstall()
    const conditions = [
      eq(projects.installId, install.install_id),
      eq(projects.tenantId, tenantId),
    ]
    if (filter.archived === false) {
      conditions.push(isNull(projects.archivedAt))
    } else if (filter.archived === true) {
      // Archived only — drizzle has no `isNotNull` helper imported here, so
      // express via raw sql.
      conditions.push(drizzleSql`${projects.archivedAt} IS NOT NULL`)
    }
    // archived === undefined: include both active + archived

    return await this.db
      .select()
      .from(projects)
      .where(and(...conditions))
      .orderBy(asc(projects.createdAt))
  }

  // -------------------------------------------------------------------------
  // get
  // -------------------------------------------------------------------------

  async get(projectId: string, tenantId: string = SENTINEL_TENANT): Promise<ProjectRow | null> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.projectId, projectId), eq(projects.tenantId, tenantId)))
      .limit(1)
    return rows[0] ?? null
  }

  async getBySlug(slug: string, installId: string): Promise<ProjectRow | null> {
    const rows = await this.db
      .select()
      .from(projects)
      .where(and(eq(projects.installId, installId), eq(projects.slug, slug)))
      .limit(1)
    return rows[0] ?? null
  }

  // -------------------------------------------------------------------------
  // update
  // -------------------------------------------------------------------------

  async update(
    input: UpdateProjectInput,
    actor: Actor = SYSTEM_ACTOR,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<ProjectRow> {
    const parsed = UpdateProjectInputSchema.parse(input)
    const existing = await this.get(parsed.projectId, tenantId)
    if (!existing) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.NOT_FOUND_PROJECT,
        `project ${parsed.projectId} not found`,
      )
    }

    const updates: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() }
    if (parsed.name !== undefined) updates.name = parsed.name
    if (parsed.description !== undefined) updates.description = parsed.description ?? null

    const [row] = await this.db
      .update(projects)
      .set(updates)
      .where(and(eq(projects.projectId, parsed.projectId), eq(projects.tenantId, tenantId)))
      .returning()

    if (!row) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.INTERNAL_DB_ERROR,
        `UPDATE project ${parsed.projectId} returned no rows`,
      )
    }

    const ev: EventInput = {
      aggregate_id: parsed.projectId,
      aggregate_type: 'install',
      event_type: 'ProjectUpdated',
      payload: {
        project_id: parsed.projectId,
        ...(parsed.name !== undefined ? { name: parsed.name } : {}),
        ...(parsed.description !== undefined
          ? { description: parsed.description ?? null }
          : {}),
      },
      actor,
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)

    return row
  }

  // -------------------------------------------------------------------------
  // archive
  // -------------------------------------------------------------------------

  async archive(projectId: string, actor: Actor = SYSTEM_ACTOR, tenantId: string = SENTINEL_TENANT): Promise<void> {
    const existing = await this.get(projectId, tenantId)
    if (!existing) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.NOT_FOUND_PROJECT,
        `project ${projectId} not found`,
      )
    }

    if (existing.archivedAt !== null) {
      // Already archived — no-op (idempotent)
      return
    }

    const now = new Date()
    await this.db
      .update(projects)
      .set({ archivedAt: now, updatedAt: now })
      .where(and(eq(projects.projectId, projectId), eq(projects.tenantId, tenantId)))

    const ev: EventInput = {
      aggregate_id: projectId,
      aggregate_type: 'install',
      event_type: 'ProjectArchived',
      payload: { project_id: projectId, archived_at: now.toISOString() },
      actor,
      trace_id: uuidv7(),
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)
  }

  // -------------------------------------------------------------------------
  // connectMonday
  // -------------------------------------------------------------------------

  async connectMonday(
    input: ConnectMondayInput,
    actor: Actor = SYSTEM_ACTOR,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<ProjectRow> {
    const parsed = ConnectMondayInputSchema.parse(input)
    const project = await this.get(parsed.projectId, tenantId)
    if (!project) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.NOT_FOUND_PROJECT,
        `project ${parsed.projectId} not found`,
      )
    }

    // Validate the board exists. We use a "list items on the board" probe
    // because MondayClient already exposes that and it returns an empty list
    // for a board with no items (vs. throwing for nonexistent).
    if (this.mondayClient !== null) {
      try {
        await this.mondayClient.getBoardItems(parsed.boardId)
      } catch (err) {
        // Translate to a user-facing error
        const msg = err instanceof Error ? err.message : String(err)
        throw new OrbitalError(
          PROJECTS_ERROR_CODES.MONDAY_CONNECT_FAILED,
          `Could not validate Monday board ${parsed.boardId}: ${msg}`,
          { board_id: parsed.boardId, cause: msg },
        )
      }
    } else {
      logger.warn(
        { projectId: parsed.projectId, boardId: parsed.boardId },
        'ProjectsService.connectMonday: no MondayClient injected; skipping validation',
      )
    }

    const now = new Date()
    const [row] = await this.db
      .update(projects)
      .set({ mondayBoardId: parsed.boardId, updatedAt: now })
      .where(and(eq(projects.projectId, parsed.projectId), eq(projects.tenantId, tenantId)))
      .returning()
    if (!row) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.INTERNAL_DB_ERROR,
        `UPDATE project monday connect returned no rows`,
      )
    }

    const ev: EventInput = {
      aggregate_id: parsed.projectId,
      aggregate_type: 'install',
      event_type: 'MondayBoardConnected',
      payload: {
        project_id: parsed.projectId,
        monday_board_id: parsed.boardId,
      },
      actor,
      trace_id: uuidv7(),
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)

    return row
  }

  // -------------------------------------------------------------------------
  // connectGithub
  // -------------------------------------------------------------------------

  async connectGithub(
    input: ConnectGithubInput,
    actor: Actor = SYSTEM_ACTOR,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<ProjectRow> {
    const parsed = ConnectGithubInputSchema.parse(input)
    const project = await this.get(parsed.projectId, tenantId)
    if (!project) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.NOT_FOUND_PROJECT,
        `project ${parsed.projectId} not found`,
      )
    }

    let resolvedDefaultBranch = parsed.defaultBranch
    if (this.githubClient !== null) {
      try {
        const repo = await this.githubClient.getRepo(parsed.owner, parsed.repo)
        if (!repo) {
          throw new OrbitalError(
            PROJECTS_ERROR_CODES.GITHUB_CONNECT_FAILED,
            `Github repo ${parsed.owner}/${parsed.repo} not found`,
            { owner: parsed.owner, repo: parsed.repo },
          )
        }
        // Prefer the actual default branch reported by Github
        resolvedDefaultBranch = repo.defaultBranch || parsed.defaultBranch
      } catch (err) {
        if (err instanceof OrbitalError && err.code === PROJECTS_ERROR_CODES.GITHUB_CONNECT_FAILED) {
          throw err
        }
        const msg = err instanceof Error ? err.message : String(err)
        throw new OrbitalError(
          PROJECTS_ERROR_CODES.GITHUB_CONNECT_FAILED,
          `Could not validate Github repo ${parsed.owner}/${parsed.repo}: ${msg}`,
          { owner: parsed.owner, repo: parsed.repo, cause: msg },
        )
      }
    } else {
      logger.warn(
        { projectId: parsed.projectId, owner: parsed.owner, repo: parsed.repo },
        'ProjectsService.connectGithub: no GithubClient injected; skipping validation',
      )
    }

    const now = new Date()
    const [row] = await this.db
      .update(projects)
      .set({
        githubOwner: parsed.owner,
        githubRepo: parsed.repo,
        githubDefaultBranch: resolvedDefaultBranch,
        updatedAt: now,
      })
      .where(and(eq(projects.projectId, parsed.projectId), eq(projects.tenantId, tenantId)))
      .returning()
    if (!row) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.INTERNAL_DB_ERROR,
        `UPDATE project github connect returned no rows`,
      )
    }

    const ev: EventInput = {
      aggregate_id: parsed.projectId,
      aggregate_type: 'install',
      event_type: 'GithubRepoConnected',
      payload: {
        project_id: parsed.projectId,
        github_owner: parsed.owner,
        github_repo: parsed.repo,
        github_default_branch: resolvedDefaultBranch,
      },
      actor,
      trace_id: uuidv7(),
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)

    return row
  }

  // -------------------------------------------------------------------------
  // ensureDefaultProject (boot-time bootstrap + back-compat backfill)
  // -------------------------------------------------------------------------

  async ensureDefaultProject(): Promise<ProjectRow> {
    const install = await loadOrCreateInstall()
    const installId = install.install_id

    // Look up by slug (idempotent re-entry)
    const existing = await this.getBySlug(DEFAULT_PROJECT_SLUG, installId)
    if (existing) return existing

    // Create the default project. Cannot call this.create() because
    // create() emits ProjectCreated; we want a distinct
    // DefaultProjectInitialized event so audit log is unambiguous.
    const projectId = uuidv7()
    const now = new Date()
    const traceId = uuidv7()

    let row: ProjectRow | undefined
    try {
      const inserted = await this.db
        .insert(projects)
        .values({
          projectId,
          installId,
          name: DEFAULT_PROJECT_NAME,
          slug: DEFAULT_PROJECT_SLUG,
          description: 'Auto-created on first boot for backward compatibility.',
          mondayBoardId: null,
          githubOwner: null,
          githubRepo: null,
          githubDefaultBranch: DEFAULT_BRANCH,
          archivedAt: null,
          createdByEventId: null,
          createdAt: now,
          updatedAt: now,
          schemaVersion: 1,
        })
        .returning()
      row = inserted[0]
    } catch (err) {
      const msg = (err as Error).message ?? ''
      if (msg.includes('projects_install_slug_uq') || msg.includes('duplicate key')) {
        // Race with another boot — fetch and return the winner
        const winner = await this.getBySlug(DEFAULT_PROJECT_SLUG, installId)
        if (winner) return winner
      }
      throw err
    }

    if (!row) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.INTERNAL_DB_ERROR,
        'INSERT default project returned no rows',
      )
    }

    const ev: EventInput = {
      aggregate_id: projectId,
      aggregate_type: 'install',
      event_type: 'DefaultProjectInitialized',
      payload: {
        project_id: projectId,
        install_id: installId,
        slug: DEFAULT_PROJECT_SLUG,
        name: DEFAULT_PROJECT_NAME,
      },
      actor: SYSTEM_ACTOR,
      trace_id: traceId,
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)

    // Backfill: any aggregate row with project_id IS NULL gets the default.
    // We do this via raw SQL to avoid hard-coding a list of Drizzle tables and
    // to keep the migration ADDITIVE-only (the SQL migration cannot do this
    // because it has no install_id at apply time).
    await this.backfillExistingRows(projectId)

    return row
  }

  // -------------------------------------------------------------------------
  // Internal: backfill aggregate rows with project_id IS NULL
  // -------------------------------------------------------------------------

  private async backfillExistingRows(defaultProjectId: string): Promise<void> {
    const tables = [
      'epics',
      'stories',
      'sprints',
      'vision_versions',
      'vision_documents',
      'channels',
      'ceremonies',
      'retro_reports',
      'uat_sessions',
      'tasks',
    ]

    for (const table of tables) {
      try {
        // table identifier is hard-coded above (not user input). Use
        // drizzleSql.raw for the table name and parameter-bind defaultProjectId
        // through the sql template for safe interpolation.
        await this.db.execute(
          drizzleSql`UPDATE ${drizzleSql.raw(table)} SET project_id = ${defaultProjectId} WHERE project_id IS NULL`,
        )
      } catch (err) {
        // Tolerate missing tables (e.g. fresh DB where migration ran but a
        // pre-existing table is conditional). Surface as warn — not fatal.
        logger.warn(
          { table, err: (err as Error).message },
          `ProjectsService.ensureDefaultProject: backfill skipped for ${table}`,
        )
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createProjectsService(
  db: DB,
  eventStore: EventStore,
  options: { mondayClient?: MondayClient | null; githubClient?: GithubClient | null } = {},
): ProjectsService {
  return new DefaultProjectsService(
    db,
    eventStore,
    options.mondayClient ?? null,
    options.githubClient ?? null,
  )
}
