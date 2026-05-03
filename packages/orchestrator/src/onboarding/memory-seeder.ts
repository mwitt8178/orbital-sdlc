/**
 * onboarding/memory-seeder.ts — converts a codebase analysis (or vision-derived
 * inputs) into project_memory_entries rows.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Real memory writes only — calls MemoryService.record so each entry emits the
 * canonical MemoryEntryRecorded event for full audit traceability. No mocks.
 *
 * Two entry points:
 *   - seedFromAnalysis(report, projectId) — Flow B (existing repo)
 *   - seedFromVision(visionContent, projectId) — Flow A (new project)
 */

import type { Actor } from '@orbital/types'
import type { MemoryService } from '../memory/service.js'
import type { CodebaseAnalysisReport, InferredMemoryEntry } from './codebase-analyzer.js'

const SYSTEM_ACTOR_ID = 'onboarding-system-teacher'

export interface MemorySeederResult {
  /** Entry IDs of every row created. */
  entryIds: string[]
  /** Per-kind counts for the UI summary. */
  countsByKind: Record<string, number>
}

export interface VisionSeedInput {
  projectId: string
  /** Free-form vision intent. */
  intent: string
  /** Stack chosen by the user / inferred from analysis. */
  stack: string[]
  /** Conventions pre-selected from defaults. */
  conventions: Array<{ title: string; body: string }>
  /** Glossary terms pulled from the vision document. */
  glossary: Array<{ term: string; definition: string }>
  tenantId?: string
}

export interface MemorySeeder {
  seedFromAnalysis(
    report: CodebaseAnalysisReport,
    projectId: string,
    tenantId?: string,
  ): Promise<MemorySeederResult>
  seedFromVision(input: VisionSeedInput): Promise<MemorySeederResult>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class DefaultMemorySeeder implements MemorySeeder {
  constructor(private readonly memory: MemoryService) {}

  async seedFromAnalysis(
    report: CodebaseAnalysisReport,
    projectId: string,
    tenantId?: string,
  ): Promise<MemorySeederResult> {
    const entryIds: string[] = []
    const countsByKind: Record<string, number> = {}

    // README summary as a project-level decision (the "what we're building" intent).
    if (report.readmeSummary) {
      const created = await this.memory.record(
        {
          projectId,
          kind: 'decision',
          title: 'Project intent (from README)',
          body: report.readmeSummary,
          sourceKind: 'agent',
          confidence: 'medium',
          scope: 'project',
          tags: ['intent', 'imported'],
          links: [],
        },
        SYSTEM_ACTOR_ID,
        tenantId,
      )
      entryIds.push(created.entryId)
      countsByKind['decision'] = (countsByKind['decision'] ?? 0) + 1
    }

    // Stack as a convention.
    if (report.stack.length > 0) {
      const created = await this.memory.record(
        {
          projectId,
          kind: 'convention',
          title: 'Detected stack',
          body: `Stack: ${report.stack.join(', ')}`,
          sourceKind: 'agent',
          confidence: 'high',
          scope: 'project',
          tags: ['stack', 'detected'],
          links: [],
        },
        SYSTEM_ACTOR_ID,
        tenantId,
      )
      entryIds.push(created.entryId)
      countsByKind['convention'] = (countsByKind['convention'] ?? 0) + 1
    }

    // Each inferred entry from the analyzer.
    for (const inferred of report.inferredMemoryEntries) {
      const created = await this.memory.record(
        toCreateInput(inferred, projectId),
        SYSTEM_ACTOR_ID,
        tenantId,
      )
      entryIds.push(created.entryId)
      countsByKind[inferred.kind] = (countsByKind[inferred.kind] ?? 0) + 1
    }

    return { entryIds, countsByKind }
  }

  async seedFromVision(input: VisionSeedInput): Promise<MemorySeederResult> {
    const entryIds: string[] = []
    const countsByKind: Record<string, number> = {}

    // 1. Vision intent → decision.
    const visionEntry = await this.memory.record(
      {
        projectId: input.projectId,
        kind: 'decision',
        title: 'Project vision',
        body: input.intent,
        sourceKind: 'vision',
        confidence: 'high',
        scope: 'project',
        tags: ['vision', 'intent'],
        links: [],
      },
      SYSTEM_ACTOR_ID,
      input.tenantId,
    )
    entryIds.push(visionEntry.entryId)
    countsByKind['decision'] = (countsByKind['decision'] ?? 0) + 1

    // 2. Stack choice → convention.
    if (input.stack.length > 0) {
      const stackEntry = await this.memory.record(
        {
          projectId: input.projectId,
          kind: 'decision',
          title: 'Stack choice',
          body: `We chose ${input.stack.join(', ')} based on the project vision.`,
          sourceKind: 'vision',
          confidence: 'high',
          scope: 'project',
          tags: ['stack'],
          links: [],
        },
        SYSTEM_ACTOR_ID,
        input.tenantId,
      )
      entryIds.push(stackEntry.entryId)
      countsByKind['decision'] = (countsByKind['decision'] ?? 0) + 1
    }

    // 3. Each pre-chosen convention.
    for (const conv of input.conventions) {
      const created = await this.memory.record(
        {
          projectId: input.projectId,
          kind: 'convention',
          title: conv.title,
          body: conv.body,
          sourceKind: 'operator',
          confidence: 'medium',
          scope: 'project',
          tags: ['conventions'],
          links: [],
        },
        SYSTEM_ACTOR_ID,
        input.tenantId,
      )
      entryIds.push(created.entryId)
      countsByKind['convention'] = (countsByKind['convention'] ?? 0) + 1
    }

    // 4. Glossary terms.
    for (const g of input.glossary) {
      const created = await this.memory.record(
        {
          projectId: input.projectId,
          kind: 'glossary',
          title: g.term,
          body: g.definition,
          sourceKind: 'vision',
          confidence: 'medium',
          scope: 'project',
          tags: ['glossary'],
          links: [],
        },
        SYSTEM_ACTOR_ID,
        input.tenantId,
      )
      entryIds.push(created.entryId)
      countsByKind['glossary'] = (countsByKind['glossary'] ?? 0) + 1
    }

    return { entryIds, countsByKind }
  }
}

function toCreateInput(inferred: InferredMemoryEntry, projectId: string) {
  const links: Array<{ linkKind: 'pr' | 'task' | 'retro' | 'vision' | 'adr'; linkValue: string }> = []
  if (inferred.source) {
    if (inferred.source.kind === 'adr') {
      links.push({ linkKind: 'adr', linkValue: inferred.source.ref })
    } else if (inferred.source.kind === 'pr') {
      links.push({ linkKind: 'pr', linkValue: inferred.source.ref })
    }
  }
  return {
    projectId,
    kind: inferred.kind,
    title: inferred.title.slice(0, 300),
    body: inferred.body.slice(0, 20_000),
    sourceKind: 'agent' as const,
    confidence: 'medium' as const,
    scope: 'project' as const,
    tags: inferred.tags,
    links,
  }
}

export function createMemorySeeder(memory: MemoryService): MemorySeeder {
  return new DefaultMemorySeeder(memory)
}

// Suppress unused-import warning on Actor (re-exported for callers building entry inputs).
export type { Actor }
