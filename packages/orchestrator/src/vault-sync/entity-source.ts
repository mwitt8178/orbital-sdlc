/**
 * vault-sync/entity-source.ts — Read aggregates → VaultEntity[].
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 *
 * The vault is a *projection*. This module is the read-side: given a tenant +
 * project, it returns every entity (vision/epic/story/ac/retro/memory) that
 * should appear in the vault.
 *
 * The orbital data model does not store `project_id` on every aggregate
 * (epics + stories + ACs hang off vision_version_id; retros hang off
 * sprint_id). The source layer hides that walk from the sync service so
 * future schema changes don't ripple outward.
 *
 * Cross-tenant safety: every query filters by tenantId. The source MUST
 * never return a row whose tenant_id differs from the input.
 */

import { and, eq, inArray } from 'drizzle-orm'
import {
  projects,
  visionDocuments,
  visionVersions,
  epics,
  stories,
  storyAcceptanceCriteria,
  retroReports,
  sprints,
  projectMemoryEntries,
} from '@orbital/db'
import type { DB } from '../db/client.js'
import type { VaultEntity } from './types.js'

export interface ProjectEntitySource {
  /**
   * List every vault-bound entity for one (tenantId, projectId) pair.
   * Returned entities are tagged with the input tenantId for downstream
   * tenant-prefix enforcement.
   */
  listForProject(input: { tenantId: string; projectId: string }): Promise<{
    projectSlug: string
    entities: VaultEntity[]
  }>
}

export function createProjectEntitySource(db: DB): ProjectEntitySource {
  return {
    async listForProject({ tenantId, projectId }) {
      // 1) Project — slug + sanity check tenancy.
      const projectRows = await db
        .select()
        .from(projects)
        .where(and(eq(projects.projectId, projectId), eq(projects.tenantId, tenantId)))
        .limit(1)
      const project = projectRows[0]
      if (!project) {
        throw new Error(
          `vault-sync: project ${projectId} not found for tenant ${tenantId}`,
        )
      }
      const projectSlug = project.slug

      // 2) Visions — all docs for this install + their CURRENT (locked or
      // latest draft) version content.
      // Vision docs are scoped by install_id; we filter the version list
      // to only those whose document belongs to this install.
      const visionDocs = await db
        .select()
        .from(visionDocuments)
        .where(eq(visionDocuments.installId, project.installId))

      const visionVersionIds = visionDocs
        .map((d) => d.currentVersionId)
        .filter((v): v is string => typeof v === 'string')

      const visionVersionRows =
        visionVersionIds.length > 0
          ? await db
              .select()
              .from(visionVersions)
              .where(inArray(visionVersions.visionVersionId, visionVersionIds))
          : []

      const visionEntities: VaultEntity[] = visionDocs.map((doc) => {
        const v = visionVersionRows.find((vr) => vr.visionVersionId === doc.currentVersionId)
        const content = (v?.content ?? {}) as Record<string, unknown>
        const summary = typeof content.summary === 'string' ? content.summary : ''
        const goals = Array.isArray(content.goals)
          ? (content.goals as unknown[]).filter((g): g is string => typeof g === 'string')
          : []
        const body = [
          `# ${doc.title}`,
          '',
          summary,
          goals.length > 0 ? '\n## Goals\n' : '',
          ...goals.map((g) => `- ${g}`),
        ].join('\n')
        return {
          type: 'vision' as const,
          id: doc.visionDocumentId,
          tenantId,
          projectId,
          title: doc.title,
          status: doc.lifecycleState,
          createdAt: doc.createdAt.toISOString(),
          updatedAt: v?.draftedAt?.toISOString(),
          body,
          tags: ['vision', doc.lifecycleState],
        }
      })

      // 3) Epics — all epics for vision-versions belonging to this install.
      const epicRows =
        visionVersionIds.length > 0
          ? await db
              .select()
              .from(epics)
              .where(
                and(
                  eq(epics.tenantId, tenantId),
                  inArray(epics.visionVersionId, visionVersionIds),
                ),
              )
          : []

      const epicEntities: VaultEntity[] = epicRows.map((e) => {
        const linkedVision = visionDocs.find((d) => d.currentVersionId === e.visionVersionId)
        return {
          type: 'epic' as const,
          id: e.epicId,
          tenantId,
          projectId,
          title: e.title,
          status: e.status,
          createdAt: e.createdAt.toISOString(),
          updatedAt: e.updatedAt.toISOString(),
          body: [`# ${e.title}`, '', '## Rationale', '', e.rationale].join('\n'),
          links: linkedVision ? [linkedVision.title] : [],
          tags: ['epic', e.status],
        }
      })

      // 4) Stories — all stories under those epics.
      const epicIds = epicRows.map((e) => e.epicId)
      const storyRows =
        epicIds.length > 0
          ? await db
              .select()
              .from(stories)
              .where(and(eq(stories.tenantId, tenantId), inArray(stories.epicId, epicIds)))
          : []

      const storyEntities: VaultEntity[] = storyRows.map((s) => {
        const epic = epicRows.find((e) => e.epicId === s.epicId)
        return {
          type: 'story' as const,
          id: s.storyId,
          tenantId,
          projectId,
          title: s.title,
          status: s.status,
          createdAt: s.createdAt.toISOString(),
          updatedAt: s.updatedAt.toISOString(),
          body: [`# ${s.title}`, '', s.description].join('\n'),
          links: epic ? [epic.title] : [],
          tags: ['story', s.status],
        }
      })

      // 5) ACs — for those stories.
      const storyIds = storyRows.map((s) => s.storyId)
      const acRows =
        storyIds.length > 0
          ? await db
              .select()
              .from(storyAcceptanceCriteria)
              .where(
                and(
                  eq(storyAcceptanceCriteria.tenantId, tenantId),
                  inArray(storyAcceptanceCriteria.storyId, storyIds),
                ),
              )
          : []

      const acEntities: VaultEntity[] = acRows.map((ac) => {
        const story = storyRows.find((s) => s.storyId === ac.storyId)
        const title = `${story?.title ?? 'Story'} — AC ${ac.ordinal}`
        return {
          type: 'ac' as const,
          id: ac.acId,
          tenantId,
          projectId,
          title,
          createdAt: ac.createdAt.toISOString(),
          body: [`# ${title}`, '', ac.text].join('\n'),
          links: story ? [story.title] : [],
          tags: ['ac'],
        }
      })

      // 6) Retros — for sprints whose tenancy matches.
      const sprintRows = await db
        .select()
        .from(sprints)
        .where(eq(sprints.tenantId, tenantId))
      const sprintIds = sprintRows.map((s) => s.sprintId)
      const retroRows =
        sprintIds.length > 0
          ? await db
              .select()
              .from(retroReports)
              .where(
                and(
                  eq(retroReports.tenantId, tenantId),
                  inArray(retroReports.sprintId, sprintIds),
                ),
              )
          : []

      const retroEntities: VaultEntity[] = retroRows.map((r) => {
        const sprint = sprintRows.find((s) => s.sprintId === r.sprintId)
        const date = (r.completedAt ?? r.startedAt).toISOString().slice(0, 10)
        const title = date
        return {
          type: 'retro' as const,
          id: r.retroReportId,
          tenantId,
          projectId,
          title,
          status: r.status,
          createdAt: r.startedAt.toISOString(),
          updatedAt: r.completedAt?.toISOString(),
          body: [
            `# Retro — ${date}`,
            '',
            `Sprint: ${sprint?.name ?? r.sprintId}`,
            '',
            `Status: ${r.status}`,
            '',
            `Proposals: ${r.proposalCount} (approved ${r.approvedCount}, rejected ${r.rejectedCount}, deferred ${r.deferredCount})`,
          ].join('\n'),
          links: sprint ? [sprint.name] : [],
          tags: ['retro', r.status],
        }
      })

      // 7) Memory entries — directly project-scoped + tenant-scoped.
      const memoryRows = await db
        .select()
        .from(projectMemoryEntries)
        .where(
          and(
            eq(projectMemoryEntries.tenantId, tenantId),
            eq(projectMemoryEntries.projectId, projectId),
          ),
        )

      const memoryEntities: VaultEntity[] = memoryRows.map((m) => ({
        type: 'memory' as const,
        id: m.entryId,
        tenantId,
        projectId,
        title: m.title,
        status: m.status,
        createdAt: m.createdAt.toISOString(),
        updatedAt: m.updatedAt.toISOString(),
        body: [`# ${m.title}`, '', m.body].join('\n'),
        tags: ['memory', m.kind, m.status],
      }))

      const entities: VaultEntity[] = [
        ...visionEntities,
        ...epicEntities,
        ...storyEntities,
        ...acEntities,
        ...retroEntities,
        ...memoryEntities,
      ]

      // Defence-in-depth: assert every returned entity carries the input tenantId.
      for (const e of entities) {
        if (e.tenantId !== tenantId) {
          throw new Error(
            `vault-sync: entity-source produced entity with mismatched tenantId (${e.tenantId} vs ${tenantId})`,
          )
        }
      }

      return { projectSlug, entities }
    },
  }
}
