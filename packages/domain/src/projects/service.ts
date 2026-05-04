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
import type { DB } from '@orbital/db'
import type { EventStore } from '../events/store.js'
import { projects, type ProjectRow } from '@orbital/db'
import { logger } from '../logger.js'
import { loadOrCreateInstall } from '../../../orchestrator/src/config/install.js'
import {
  CreateProjectInputSchema,
  UpdateProjectInputSchema,
  ConnectMondayInputSchema,
  ConnectGithubInputSchema,
  ResetProjectInputSchema,
  DeleteProjectInputSchema,
  ArchiveProjectInputSchema,
  RESERVED_PROJECT_SLUGS,
  PROJECTS_ERROR_CODES,
  type CreateProjectInput,
  type UpdateProjectInput,
  type ConnectMondayInput,
  type ConnectGithubInput,
  type ResetProjectInput,
  type DeleteProjectInput,
  type ArchiveProjectInput,
} from './types.js'
import type { MondayClient } from '../backlog/monday-client.js'
import type { GithubClient } from '../../../orchestrator/src/github/client.js'
import type { ScmClient } from '../../../orchestrator/src/scm/client.js'

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

// ---------------------------------------------------------------------------
// Read-side metadata for /settings/general
// [Engineer-Principal · Opus · run-settings-general]
// ---------------------------------------------------------------------------

export interface ProjectMetadata {
  projectId: string
  tenantId: string
  createdAt: string
  /** Email of the actor who created the project, if recoverable from event log. */
  createdByEmail: string | null
  /** ISO timestamp of the most recent event touching this project. */
  lastActivityAt: string | null
  /** Total event count for this project (capped read). */
  eventCount: number
}

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface ProjectsService {
  create(input: CreateProjectInput, actor?: Actor, tenantId?: string): Promise<ProjectRow>
  list(filter?: { archived?: boolean }, tenantId?: string): Promise<ProjectRow[]>
  get(projectId: string, tenantId?: string): Promise<ProjectRow | null>
  getBySlug(slug: string, installId: string): Promise<ProjectRow | null>
  update(input: UpdateProjectInput, actor?: Actor, tenantId?: string): Promise<ProjectRow>
  archive(input: ArchiveProjectInput | string, actor?: Actor, tenantId?: string): Promise<void>
  reset(input: ResetProjectInput, actor?: Actor, tenantId?: string): Promise<{ cleared: Record<string, number> }>
  delete(input: DeleteProjectInput, actor?: Actor, tenantId?: string, opts?: { isAdmin: boolean }): Promise<void>
  metadata(projectId: string, tenantId?: string): Promise<ProjectMetadata>
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
    /**
     * Optional SCM client used to provision a per-project repository when
     * `scmProvider` is 'internal' or 'codecommit'. When null, project rows
     * are still created but repo_id/repo_url remain NULL until backfilled.
     * [Engineer-Principal · Opus · run-scm-codecommit]
     */
    private readonly scmClient: ScmClient | null = null,
    /**
     * Optional tenant slug used to namespace provisioned repos
     * (orbital-{tenantSlug}-{projectSlug}). Defaults to 'install'.
     */
    private readonly tenantSlug: string = 'install',
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
    const scmProvider = parsed.scmProvider ?? 'internal'
    const ticketProvider = parsed.ticketProvider ?? 'internal'

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
          scmProvider,
          ticketProvider,
          repoId: null,
          repoUrl: null,
          repoCloneUrl: null,
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

    // ---------------------------------------------------------------------
    // Provision a per-project SCM repo when the provider is Orbital-managed.
    // [Engineer-Principal · Opus · run-scm-codecommit]
    //
    // 'github' is delegated to the explicit connectGithub flow; we only
    // auto-provision for 'internal' (default) and 'codecommit'.
    // ---------------------------------------------------------------------
    let provisionedRepoId: string | null = null
    let provisionedRepoUrl: string | null = null
    let provisionedCloneUrl: string | null = null
    if (this.scmClient !== null && (scmProvider === 'internal' || scmProvider === 'codecommit')) {
      const repoName = buildRepoName(this.tenantSlug, parsed.slug)
      try {
        const handle = await this.scmClient.createRepo(
          repoName,
          parsed.description ?? `Orbital project ${parsed.name}`,
        )
        provisionedRepoId = handle.repoId
        provisionedRepoUrl = handle.repoUrl
        provisionedCloneUrl = handle.cloneUrlHttp

        // Land an initial README on the default branch so PRs are possible
        // and the repo is browseable. Tolerate failures here (the repo
        // exists; users can seed it manually) but log loudly.
        try {
          await this.scmClient.commitFiles(
            handle.repoId,
            DEFAULT_BRANCH,
            [
              {
                path: 'README.md',
                content_utf8:
                  `# ${parsed.name}\n\n` +
                  `${parsed.description ?? 'Orbital-managed project repository.'}\n\n` +
                  `- project_id: \`${projectId}\`\n` +
                  `- install_id: \`${installId}\`\n` +
                  `- created: ${now.toISOString()}\n`,
              },
            ],
            'chore: initial commit (Orbital-managed)',
          )
        } catch (seedErr) {
          logger.warn(
            { err: seedErr, repoId: handle.repoId },
            'ProjectsService.create: initial README seed failed; repo created but empty',
          )
        }

        await this.db
          .update(projects)
          .set({
            repoId: provisionedRepoId,
            repoUrl: provisionedRepoUrl,
            repoCloneUrl: provisionedCloneUrl,
          })
          .where(eq(projects.projectId, projectId))
      } catch (err) {
        logger.error(
          { err, projectId, repoName },
          'ProjectsService.create: SCM repo provisioning failed',
        )
        throw new OrbitalError(
          PROJECTS_ERROR_CODES.SCM_PROVISION_FAILED,
          `SCM repo provisioning failed: ${(err as Error).message}`,
          { repo_name: repoName, scm_provider: scmProvider },
        )
      }
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
        scm_provider: scmProvider,
        ticket_provider: ticketProvider,
        repo_id: provisionedRepoId,
        repo_url: provisionedRepoUrl,
        repo_clone_url: provisionedCloneUrl,
        // Round 9 — record onboarding provisioning intent for audit.
        provisioning: parsed.provisioning ?? null,
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

    return {
      ...row,
      createdByEventId: envelope.event_id,
      repoId: provisionedRepoId ?? row.repoId,
      repoUrl: provisionedRepoUrl ?? row.repoUrl,
      repoCloneUrl: provisionedCloneUrl ?? row.repoCloneUrl,
    }
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

    // Slug change validation: reserved-list + tenant-scoped uniqueness.
    // [Engineer-Principal · Opus · run-settings-general]
    if (parsed.slug !== undefined && parsed.slug !== existing.slug) {
      if (RESERVED_PROJECT_SLUGS.includes(parsed.slug as (typeof RESERVED_PROJECT_SLUGS)[number])) {
        throw new OrbitalError(
          PROJECTS_ERROR_CODES.RESERVED_SLUG,
          `slug '${parsed.slug}' is reserved`,
        )
      }
      const collision = await this.db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.installId, existing.installId),
            eq(projects.slug, parsed.slug),
            eq(projects.tenantId, tenantId),
          ),
        )
        .limit(1)
      if (collision[0] && collision[0].projectId !== parsed.projectId) {
        throw new OrbitalError(
          PROJECTS_ERROR_CODES.CONFLICT_SLUG,
          `slug '${parsed.slug}' already in use within this install`,
        )
      }
    }

    // Tenant-scoped duplicate-name check (case-insensitive).
    if (parsed.name !== undefined && parsed.name.trim() !== existing.name.trim()) {
      const sameName = await this.db
        .select()
        .from(projects)
        .where(
          and(
            eq(projects.installId, existing.installId),
            eq(projects.tenantId, tenantId),
            drizzleSql`lower(${projects.name}) = lower(${parsed.name})`,
            drizzleSql`${projects.archivedAt} IS NULL`,
          ),
        )
        .limit(1)
      if (sameName[0] && sameName[0].projectId !== parsed.projectId) {
        throw new OrbitalError(
          PROJECTS_ERROR_CODES.CONFLICT_SLUG,
          `another active project already uses the name '${parsed.name}'`,
        )
      }
    }

    const updates: Partial<typeof projects.$inferInsert> = { updatedAt: new Date() }
    if (parsed.name !== undefined) updates.name = parsed.name
    if (parsed.slug !== undefined) updates.slug = parsed.slug
    if (parsed.description !== undefined) updates.description = parsed.description ?? null
    if (parsed.color !== undefined) updates.color = parsed.color ?? null

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
        ...(parsed.slug !== undefined ? { slug: parsed.slug } : {}),
        ...(parsed.color !== undefined ? { color: parsed.color ?? null } : {}),
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

  async archive(
    input: ArchiveProjectInput | string,
    actor: Actor = SYSTEM_ACTOR,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<void> {
    // Backwards-compatible: legacy callers pass the projectId string directly.
    // [Engineer-Principal · Opus · run-settings-general]
    const projectId = typeof input === 'string' ? input : input.projectId
    const confirmName = typeof input === 'string' ? null : input.confirmName

    const existing = await this.get(projectId, tenantId)
    if (!existing) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.NOT_FOUND_PROJECT,
        `project ${projectId} not found`,
      )
    }

    if (confirmName !== null && confirmName.trim() !== existing.name.trim()) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.CONFIRM_MISMATCH,
        `typed name '${confirmName}' did not match project name`,
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
  // reset — clears child aggregate rows, leaves the project row in place.
  // [Engineer-Principal · Opus · run-settings-general]
  // -------------------------------------------------------------------------

  async reset(
    input: ResetProjectInput,
    actor: Actor = SYSTEM_ACTOR,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<{ cleared: Record<string, number> }> {
    const parsed = ResetProjectInputSchema.parse(input)
    const existing = await this.get(parsed.projectId, tenantId)
    if (!existing) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.NOT_FOUND_PROJECT,
        `project ${parsed.projectId} not found`,
      )
    }
    if (parsed.confirmName.trim() !== existing.name.trim()) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.CONFIRM_MISMATCH,
        `typed name did not match project name`,
      )
    }

    const childTables = [
      'epics',
      'stories',
      'sprints',
      'channels',
      'ceremonies',
      'retro_reports',
      'uat_sessions',
      'tasks',
    ]

    const cleared: Record<string, number> = {}
    for (const table of childTables) {
      try {
        const result = await this.db.execute(
          drizzleSql`DELETE FROM ${drizzleSql.raw(table)} WHERE project_id = ${parsed.projectId}`,
        )
        // drizzle-orm pg execute returns { rowCount } on the underlying QueryResult.
        const rc = (result as unknown as { rowCount?: number }).rowCount ?? 0
        cleared[table] = rc
      } catch (err) {
        logger.warn(
          { table, err: (err as Error).message },
          `ProjectsService.reset: skipped clearing ${table}`,
        )
        cleared[table] = 0
      }
    }

    const now = new Date()
    await this.db
      .update(projects)
      .set({ updatedAt: now })
      .where(and(eq(projects.projectId, parsed.projectId), eq(projects.tenantId, tenantId)))

    const ev: EventInput = {
      aggregate_id: parsed.projectId,
      aggregate_type: 'install',
      event_type: 'ProjectReset',
      payload: { project_id: parsed.projectId, cleared, reset_at: now.toISOString() },
      actor,
      trace_id: uuidv7(),
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)

    return { cleared }
  }

  // -------------------------------------------------------------------------
  // delete — admin-only hard delete.
  // [Engineer-Principal · Opus · run-settings-general]
  // -------------------------------------------------------------------------

  async delete(
    input: DeleteProjectInput,
    actor: Actor = SYSTEM_ACTOR,
    tenantId: string = SENTINEL_TENANT,
    opts: { isAdmin: boolean } = { isAdmin: false },
  ): Promise<void> {
    if (!opts.isAdmin) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.FORBIDDEN,
        `projects.delete requires admin role`,
      )
    }
    const parsed = DeleteProjectInputSchema.parse(input)
    const existing = await this.get(parsed.projectId, tenantId)
    if (!existing) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.NOT_FOUND_PROJECT,
        `project ${parsed.projectId} not found`,
      )
    }
    if (parsed.confirmName.trim() !== existing.name.trim()) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.CONFIRM_MISMATCH,
        `typed name did not match project name`,
      )
    }

    const now = new Date()

    // Hard-delete: also clears children (reuse reset logic) then sets
    // deleted_at on the project row to act as a tombstone before final DELETE.
    // We do NOT physically DELETE the project row in this MVP — keeping the
    // tombstone allows cross-aggregate audit references to remain resolvable.
    // A separate sweeper (out of scope) can purge after a retention window.
    const childTables = [
      'epics',
      'stories',
      'sprints',
      'channels',
      'ceremonies',
      'retro_reports',
      'uat_sessions',
      'tasks',
      'vision_versions',
      'vision_documents',
    ]
    for (const table of childTables) {
      try {
        await this.db.execute(
          drizzleSql`DELETE FROM ${drizzleSql.raw(table)} WHERE project_id = ${parsed.projectId}`,
        )
      } catch (err) {
        logger.warn(
          { table, err: (err as Error).message },
          `ProjectsService.delete: skipped clearing ${table}`,
        )
      }
    }

    const ev: EventInput = {
      aggregate_id: parsed.projectId,
      aggregate_type: 'install',
      event_type: 'ProjectDeleted',
      payload: {
        project_id: parsed.projectId,
        recovery_email: parsed.recoveryEmail,
        deleted_at: now.toISOString(),
      },
      actor,
      trace_id: uuidv7(),
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    const envelope = await this.eventStore.append(ev)

    await this.db
      .update(projects)
      .set({
        deletedAt: now,
        archivedAt: existing.archivedAt ?? now,
        deletedByEventId: envelope.event_id,
        updatedAt: now,
      })
      .where(and(eq(projects.projectId, parsed.projectId), eq(projects.tenantId, tenantId)))
  }

  // -------------------------------------------------------------------------
  // metadata — read-only join over audit.events for /settings/general.
  // [Engineer-Principal · Opus · run-settings-general]
  // -------------------------------------------------------------------------

  async metadata(
    projectId: string,
    tenantId: string = SENTINEL_TENANT,
  ): Promise<ProjectMetadata> {
    const existing = await this.get(projectId, tenantId)
    if (!existing) {
      throw new OrbitalError(
        PROJECTS_ERROR_CODES.NOT_FOUND_PROJECT,
        `project ${projectId} not found`,
      )
    }

    // Latest activity + creator email + count via a single targeted query.
    // Events for this project can land in two shapes:
    //   1. aggregate_id = projectId (project lifecycle events)
    //   2. payload->>'project_id' = projectId  (child aggregate events)
    let lastActivityAt: string | null = null
    let createdByEmail: string | null = null
    let eventCount = 0
    try {
      const activityRows = await this.db.execute<{ max_occurred: string | null; cnt: string }>(
        drizzleSql`
          SELECT max(occurred_at)::text AS max_occurred,
                 count(*)::text          AS cnt
          FROM audit.events
          WHERE aggregate_id = ${projectId}
             OR payload->>'project_id' = ${projectId}
        `,
      )
      const r = (activityRows as unknown as { rows?: Array<{ max_occurred: string | null; cnt: string }> }).rows
        ?? (activityRows as unknown as Array<{ max_occurred: string | null; cnt: string }>)
      const first = Array.isArray(r) ? r[0] : undefined
      if (first) {
        lastActivityAt = first.max_occurred ?? null
        eventCount = Number.parseInt(first.cnt ?? '0', 10) || 0
      }

      // Try to recover the creating actor's email from the ProjectCreated
      // event for this project.
      const creatorRows = await this.db.execute<{ actor: { email?: string } | null }>(
        drizzleSql`
          SELECT actor
          FROM audit.events
          WHERE aggregate_id = ${projectId}
            AND event_type = 'ProjectCreated'
          ORDER BY occurred_at ASC
          LIMIT 1
        `,
      )
      const c = (creatorRows as unknown as { rows?: Array<{ actor: { email?: string } | null }> }).rows
        ?? (creatorRows as unknown as Array<{ actor: { email?: string } | null }>)
      const cf = Array.isArray(c) ? c[0] : undefined
      if (cf && cf.actor && typeof cf.actor === 'object' && 'email' in cf.actor) {
        const email = (cf.actor as { email?: unknown }).email
        if (typeof email === 'string') createdByEmail = email
      }
    } catch (err) {
      logger.warn(
        { projectId, err: (err as Error).message },
        'ProjectsService.metadata: event lookup failed; returning partial',
      )
    }

    return {
      projectId,
      tenantId: existing.tenantId,
      createdAt: existing.createdAt.toISOString(),
      createdByEmail,
      lastActivityAt,
      eventCount,
    }
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
  options: {
    mondayClient?: MondayClient | null
    githubClient?: GithubClient | null
    scmClient?: ScmClient | null
    tenantSlug?: string
  } = {},
): ProjectsService {
  return new DefaultProjectsService(
    db,
    eventStore,
    options.mondayClient ?? null,
    options.githubClient ?? null,
    options.scmClient ?? null,
    options.tenantSlug ?? 'install',
  )
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a CodeCommit-friendly repo name: orbital-{tenant}-{project}.
 * CodeCommit repo names are 1..100 chars, [A-Za-z0-9._-]. We lowercase and
 * strip anything else to be safe.
 * [Engineer-Principal · Opus · run-scm-codecommit]
 */
function buildRepoName(tenantSlug: string, projectSlug: string): string {
  const sanitise = (s: string): string =>
    s
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
  const t = sanitise(tenantSlug || 'install')
  const p = sanitise(projectSlug)
  const raw = `orbital-${t}-${p}`
  return raw.slice(0, 100)
}
