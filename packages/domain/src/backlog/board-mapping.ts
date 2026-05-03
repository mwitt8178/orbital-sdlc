/**
 * backlog/board-mapping.ts — BoardMappingService.
 *
 * Per Round 5 Monday Board Discovery spec.
 *
 * The mapping is the bridge between Orbital's canonical SDLC concepts
 * (status, estimate, priority, AC, assignee) and a Monday board's actual
 * column ids and labels. It is per-project so different projects can use
 * different boards with different shapes.
 *
 * Workflow:
 *   1. propose(schema)    — read the schema and return a BoardMapping
 *      proposal. If AnthropicDriver is available, the LLM refines the
 *      heuristic baseline.
 *   2. confirm(mapping)   — persist the mapping with confirmed_at = now().
 *      The MondaySyncService and personas only honor confirmed mappings.
 *   3. get(project_id)    — read the active confirmed mapping for a project.
 *
 * No raw Monday calls happen here — this layer is purely about translating a
 * BoardSchema (already discovered) into a BoardMapping (the team's chosen
 * mapping). Persistence goes through the local DB; events flow through
 * EventStore.
 */

import { uuidv7 } from 'uuidv7'
import { z } from 'zod'
import { eq, and, desc, isNotNull } from 'drizzle-orm'
import type { Actor, EventInput } from '@orbital/types'
import type { DB } from '@orbital/db'
import type { EventStore } from '../events/store.js'
import { boardMappings } from '@orbital/db'
import type { BoardSchema, BoardColumn } from './board-discovery.js'
import { logger } from '../logger.js'
import type { AnthropicDriver, DriverPersonaSlug } from '../../../orchestrator/src/personas/anthropic-driver.js'

// ---------------------------------------------------------------------------
// Canonical lifecycle states (mirrors backlog STORY_STATUS minus Orbital
// internal states like 'cancelled' that don't correspond to user-board states)
// ---------------------------------------------------------------------------

export const ORBITAL_STATES = [
  'backlog',
  'ready',
  'in_progress',
  'in_review',
  'done',
  'accepted',
  'defective',
] as const
export type OrbitalState = (typeof ORBITAL_STATES)[number]

// ---------------------------------------------------------------------------
// BoardMapping — public interface
// ---------------------------------------------------------------------------

export type StoryPointsUnit = 'story_points' | 'hours' | 't_shirt' | 'none'

export interface BoardMapping {
  board_id: string
  project_id: string
  /** The Monday column we treat as the lifecycle state. NULL = no mapping. */
  status_column_id: string | null
  /**
   * Mapping from Monday status label TEXT (case-insensitive match) to Orbital
   * state. Empty when status_column_id is null. Labels not in this dict are
   * treated as 'backlog' by the resolver (with a warning log).
   */
  status_label_to_state: Record<string, OrbitalState>
  estimate_column_id: string | null
  priority_column_id: string | null
  /** When AC lives in a text/long-text column on the parent item. */
  ac_column_id: string | null
  /**
   * When AC lives in subitems (each AC = a subitem). The subitem template id
   * is the "parent column id" used to attach subitems on creation. Either
   * `ac_column_id` OR `ac_subitem_template_id` is set, never both.
   */
  ac_subitem_template_id: string | null
  assignee_column_id: string | null
  story_points_unit: StoryPointsUnit
  /**
   * What the team calls these objects. Defaults to canonical names. We surface
   * these in persona prompts so generated comments use the team's vocabulary.
   */
  monday_terminology: {
    epic: string
    story: string
    task: string
    sprint: string
  }
  /** ISO timestamp when the user (or system) confirmed the mapping. */
  confirmed_at: string | null
  confirmed_by: string | null
}

export const BoardMappingSchema = z.object({
  board_id: z.string().min(1),
  project_id: z.string().uuid(),
  status_column_id: z.string().nullable(),
  status_label_to_state: z.record(z.string(), z.enum(ORBITAL_STATES)),
  estimate_column_id: z.string().nullable(),
  priority_column_id: z.string().nullable(),
  ac_column_id: z.string().nullable(),
  ac_subitem_template_id: z.string().nullable(),
  assignee_column_id: z.string().nullable(),
  story_points_unit: z.enum(['story_points', 'hours', 't_shirt', 'none']),
  monday_terminology: z.object({
    epic: z.string().min(1),
    story: z.string().min(1),
    task: z.string().min(1),
    sprint: z.string().min(1),
  }),
  confirmed_at: z.string().nullable(),
  confirmed_by: z.string().nullable(),
})

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface BoardMappingProposeOptions {
  /** Override project_id; if not provided, the schema's mapping is project-less. */
  projectId: string
}

export interface BoardMappingService {
  /**
   * Propose a mapping given a discovered schema. Heuristic-first; refines
   * via the LLM if AnthropicDriver is configured. The proposal is NOT
   * persisted — caller must call confirm() to persist.
   */
  propose(schema: BoardSchema, options: BoardMappingProposeOptions): Promise<BoardMapping>

  /**
   * Persist a mapping with confirmed_at = now(). Idempotent on
   * (project_id, board_id) — re-confirming overwrites the existing row.
   * Emits BoardMappingConfirmed.
   */
  confirm(mapping: BoardMapping, actor: Actor): Promise<void>

  /**
   * Read the active confirmed mapping for a project. Returns null when no
   * mapping has been confirmed.
   */
  get(projectId: string): Promise<BoardMapping | null>
}

// ---------------------------------------------------------------------------
// Heuristic mapper (pure function, exported for tests)
// ---------------------------------------------------------------------------

/**
 * Heuristic baseline mapping. Operates on column titles + types + sample
 * values. Returns a BoardMapping with confirmed_at = null.
 *
 * Heuristics:
 *   - status_column_id: pick the first 'status' column whose title matches
 *     /(status|state)/i; otherwise pick the first 'status' column.
 *   - status_label_to_state: fuzzy-match each label against canonical state
 *     names (case-insensitive substring). Unknown labels default to 'backlog'.
 *   - estimate_column_id: pick the first 'numbers' column whose title matches
 *     /(point|estimate|hours|effort|size)/i.
 *   - priority_column_id: pick the first column (status or dropdown) whose
 *     title matches /priority/i.
 *   - ac_column_id: pick the first 'long-text' column whose title matches
 *     /(acceptance|criteria|ac|definition.of.done|dod)/i.
 *   - ac_subitem_template_id: if has_subitems and the subitem schema has a
 *     'text' column whose title matches /(criter|test|expect)/i, use that
 *     column's id; otherwise null. (This is the AC-as-subitem pattern.)
 *   - assignee_column_id: pick the first 'people' column.
 *   - story_points_unit: infer from estimate column title — 'point' →
 *     'story_points'; 'hours' → 'hours'; 't_shirt' if labels include S/M/L;
 *     else 'none'.
 *
 * Total of >=6 column-type heuristics covered: status (color), numbers, text,
 * long-text, people, dropdown, formula (skipped), mirror (skipped).
 */
export function heuristicMap(
  schema: BoardSchema,
  options: { projectId: string },
): BoardMapping {
  const { columns, status_columns, has_subitems, subitem_columns } = schema

  // status_column_id
  const statusCols = columns.filter((c) => c.type === 'status')
  const explicitStatus = statusCols.find((c) => /\b(status|state)\b/i.test(c.title))
  const statusCol = explicitStatus ?? statusCols[0] ?? null

  // status_label_to_state
  const statusLabelToState: Record<string, OrbitalState> = {}
  if (statusCol) {
    const found = status_columns.find((s) => s.column_id === statusCol.column_id)
    for (const lbl of found?.labels ?? []) {
      statusLabelToState[lbl.label] = matchLabelToState(lbl.label)
    }
  }

  // estimate_column_id
  const numberCols = columns.filter((c) => c.type === 'numbers')
  const estimateCol =
    numberCols.find((c) => /\b(point|estimate|hours|effort|size)/i.test(c.title)) ??
    null

  // priority_column_id (often a status with title ~ priority, sometimes a dropdown)
  const priorityCandidates = columns.filter(
    (c) => c.type === 'status' || c.type === 'dropdown',
  )
  const priorityCol =
    priorityCandidates.find((c) => /priority/i.test(c.title)) ?? null

  // ac_column_id (long-text first; some teams use plain text)
  const longTextCols = columns.filter((c) => c.type === 'long-text')
  const acTextCol =
    longTextCols.find((c) =>
      /(acceptance|criteria|\bac\b|definition.of.done|\bdod\b)/i.test(c.title),
    ) ?? null

  // ac_subitem_template_id — only if subitems are present AND the parent board
  // has a column named like AC, or the subitem name itself looks AC-shaped.
  let acSubitemId: string | null = null
  if (has_subitems && subitem_columns) {
    const candidate = subitem_columns.find(
      (c) =>
        (c.type === 'text' || c.type === 'long-text') &&
        /(criter|test|expect|given|when|then)/i.test(c.title),
    )
    if (candidate) {
      acSubitemId = candidate.column_id
    } else {
      // Many teams just use the subitem name itself as the AC. We mark this
      // as available by setting acSubitemId to the special token 'name'.
      acSubitemId = 'name'
    }
  }

  // Don't double-assign: if we have a long-text AC column on the parent,
  // prefer that over the subitem path (less ambiguous).
  if (acTextCol && acSubitemId) {
    acSubitemId = null
  }

  // assignee_column_id
  const assigneeCol = columns.find((c) => c.type === 'people') ?? null

  // story_points_unit
  let storyPointsUnit: StoryPointsUnit = 'none'
  if (estimateCol) {
    if (/hour/i.test(estimateCol.title)) storyPointsUnit = 'hours'
    else if (/point/i.test(estimateCol.title)) storyPointsUnit = 'story_points'
    else if (/t.shirt|size/i.test(estimateCol.title)) storyPointsUnit = 't_shirt'
    else storyPointsUnit = 'story_points' // sensible default
  }

  return {
    board_id: schema.board_id,
    project_id: options.projectId,
    status_column_id: statusCol?.column_id ?? null,
    status_label_to_state: statusLabelToState,
    estimate_column_id: estimateCol?.column_id ?? null,
    priority_column_id: priorityCol?.column_id ?? null,
    ac_column_id: acTextCol?.column_id ?? null,
    ac_subitem_template_id: acSubitemId,
    assignee_column_id: assigneeCol?.column_id ?? null,
    story_points_unit: storyPointsUnit,
    monday_terminology: inferTerminology(columns, schema),
    confirmed_at: null,
    confirmed_by: null,
  }
}

/**
 * Match a Monday status label (e.g. "Working on it", "Done", "Stuck") to one
 * of our canonical states using fuzzy substring matching. Returns 'backlog'
 * as a safe default when no rule fires.
 */
export function matchLabelToState(label: string): OrbitalState {
  const l = label.toLowerCase()
  // Order matters: more specific rules first.
  if (/accept|sign.?off|approved|delivered/i.test(l)) return 'accepted'
  if (/(in.?review|review|waiting.?for|pr.?open|qa)/i.test(l)) return 'in_review'
  if (/(in.?progress|working|doing|wip|started)/i.test(l)) return 'in_progress'
  if (/(ready|to.?do|todo|next|planned|prioritized|prioritised|new)/i.test(l)) return 'ready'
  if (/(done|complete|finish|closed|merged|shipped)/i.test(l)) return 'done'
  if (/(defect|bug|broken|stuck|blocked|fail)/i.test(l)) return 'defective'
  if (/(backlog|icebox|idea|draft)/i.test(l)) return 'backlog'
  return 'backlog'
}

function inferTerminology(
  columns: BoardColumn[],
  schema: BoardSchema,
): { epic: string; story: string; task: string; sprint: string } {
  // Monday boards often have an 'Item' or 'Task' header. We default to
  // 'epic'/'story'/'task'/'sprint' but try to detect a few common variants.
  const titles = columns.map((c) => c.title.toLowerCase()).join(' ')
  const boardNameLower = schema.board_name.toLowerCase()
  const epicWord = /\binitiative\b/.test(titles) ? 'initiative' : 'epic'
  const storyWord = /\bfeature\b/.test(titles) ? 'feature' : 'story'
  const taskWord = /\btask\b/.test(titles + ' ' + boardNameLower) ? 'task' : 'task'
  const sprintWord = /\biteration\b/.test(titles + ' ' + boardNameLower) ? 'iteration' : 'sprint'
  return { epic: epicWord, story: storyWord, task: taskWord, sprint: sprintWord }
}

// ---------------------------------------------------------------------------
// LLM-assisted refinement
// ---------------------------------------------------------------------------

/**
 * Prompt template for the LLM mapping refinement step. The driver enforces
 * structured output via tool-use against BoardMappingSchema, so the LLM cannot
 * hallucinate keys or types — it can only refine values.
 *
 * Cost: ~$0.001 per call on Haiku. We use Haiku via riskClass='low'.
 */
export const LLM_MAPPING_SYSTEM_PROMPT = `You are mapping a Monday.com board to canonical SDLC concepts for an autonomous engineering platform.

Given a BoardSchema (the discovered shape of a Monday board) and a heuristic baseline mapping, refine the mapping so it matches what a real user of this board would consider correct. Specifically:

- Pick the STATUS column that drives lifecycle (look at column titles, types, and sample values; prefer the column actually used as the workflow state).
- For each status label, pick the closest Orbital state from this enum: backlog, ready, in_progress, in_review, done, accepted, defective.
- Identify the ESTIMATE column (story points, hours, or t-shirt size) and set story_points_unit.
- Identify the PRIORITY column.
- Decide where Acceptance Criteria live: a long-text column on the parent item (set ac_column_id) OR each AC as a subitem (set ac_subitem_template_id to the subitem column id, or 'name' if the subitem name itself is the AC). Set the unused field to null.
- Identify the ASSIGNEE column (a 'people' column).
- Use the team's vocabulary in monday_terminology (e.g. "initiative" instead of "epic", "feature" instead of "story") if the column titles reveal a different convention.

Always return all required fields. Set fields to null when you cannot make a confident pick. Use board_id and project_id from the input verbatim. confirmed_at and confirmed_by must be null in the proposal.`

/**
 * Build the user prompt for the LLM mapping call.
 */
export function buildLlmUserPrompt(
  schema: BoardSchema,
  baseline: BoardMapping,
): string {
  // Strip large fields so the prompt stays compact. We keep titles, types,
  // and a small slice of sample values per column.
  const compactSchema = {
    board_id: schema.board_id,
    board_name: schema.board_name,
    columns: schema.columns.map((c) => ({
      column_id: c.column_id,
      title: c.title,
      type: c.type,
      sample_values: c.sample_values.slice(0, 3),
    })),
    status_columns: schema.status_columns,
    has_subitems: schema.has_subitems,
    subitem_columns: schema.subitem_columns?.map((c) => ({
      column_id: c.column_id,
      title: c.title,
      type: c.type,
    })),
    sample_item_count: schema.sample_items.length,
  }
  return [
    'BoardSchema:',
    '```json',
    JSON.stringify(compactSchema, null, 2),
    '```',
    '',
    'Heuristic baseline (refine, do not regress):',
    '```json',
    JSON.stringify(baseline, null, 2),
    '```',
    '',
    `Return the refined BoardMapping. project_id MUST be ${baseline.project_id}.`,
  ].join('\n')
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export interface DefaultBoardMappingServiceOptions {
  /** Optional AnthropicDriver for LLM refinement. */
  driver?: AnthropicDriver | null
  /** Optional install id for cost reporting. */
  installId?: string
  /** Persona used in the driver call (default 'pm'). */
  driverPersona?: DriverPersonaSlug
}

const SYSTEM_ACTOR_FALLBACK: Actor = { type: 'system', component: 'orchestrator' }

export class DefaultBoardMappingService implements BoardMappingService {
  private readonly driver: AnthropicDriver | null
  private readonly driverPersona: DriverPersonaSlug

  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
    options: DefaultBoardMappingServiceOptions = {},
  ) {
    this.driver = options.driver ?? null
    this.driverPersona = options.driverPersona ?? 'pm'
  }

  async propose(
    schema: BoardSchema,
    options: BoardMappingProposeOptions,
  ): Promise<BoardMapping> {
    const baseline = heuristicMap(schema, { projectId: options.projectId })

    if (this.driver) {
      try {
        const result = await this.driver.invoke<BoardMapping>({
          persona: this.driverPersona,
          riskClass: 'low',
          sessionId: `board-mapping:${options.projectId}:${schema.board_id}`,
          systemPrompt: LLM_MAPPING_SYSTEM_PROMPT,
          userPrompt: buildLlmUserPrompt(schema, baseline),
          responseSchema: BoardMappingSchema as z.ZodType<BoardMapping>,
        })
        const refined = result.result
        // Defensive: ensure project_id and board_id were preserved.
        refined.project_id = options.projectId
        refined.board_id = schema.board_id
        refined.confirmed_at = null
        refined.confirmed_by = null
        return refined
      } catch (err) {
        logger.warn(
          { err: (err as Error).message, projectId: options.projectId },
          'BoardMappingService.propose: LLM refinement failed; falling back to heuristic',
        )
        return baseline
      }
    }

    return baseline
  }

  async confirm(mapping: BoardMapping, actor: Actor): Promise<void> {
    const validated = BoardMappingSchema.parse(mapping)
    const now = new Date()
    const confirmedBy = actorToString(actor)
    const confirmedJson: BoardMapping = {
      ...validated,
      confirmed_at: now.toISOString(),
      confirmed_by: confirmedBy,
    }

    // Upsert on (project_id, board_id).
    const existing = await this.db
      .select()
      .from(boardMappings)
      .where(
        and(
          eq(boardMappings.projectId, validated.project_id),
          eq(boardMappings.boardId, validated.board_id),
        ),
      )
      .limit(1)

    if (existing[0]) {
      await this.db
        .update(boardMappings)
        .set({
          mappingJson: confirmedJson,
          confirmedAt: now,
          confirmedBy,
        })
        .where(eq(boardMappings.mappingId, existing[0].mappingId))
    } else {
      await this.db.insert(boardMappings).values({
        mappingId: uuidv7(),
        projectId: validated.project_id,
        boardId: validated.board_id,
        mappingJson: confirmedJson,
        proposedAt: now,
        confirmedAt: now,
        confirmedBy,
        schemaVersion: 1,
      })
    }

    const ev: EventInput = {
      aggregate_id: validated.project_id,
      aggregate_type: 'install',
      event_type: 'BoardMappingConfirmed',
      payload: {
        project_id: validated.project_id,
        board_id: validated.board_id,
        status_column_id: validated.status_column_id,
        ac_source_kind: validated.ac_subitem_template_id
          ? 'subitem'
          : validated.ac_column_id
            ? 'column'
            : 'none',
        story_points_unit: validated.story_points_unit,
      },
      actor,
      trace_id: uuidv7(),
      occurred_at: now.toISOString(),
      schema_version: 1,
    }
    await this.eventStore.append(ev)
  }

  async get(projectId: string): Promise<BoardMapping | null> {
    const rows = await this.db
      .select()
      .from(boardMappings)
      .where(
        and(eq(boardMappings.projectId, projectId), isNotNull(boardMappings.confirmedAt)),
      )
      .orderBy(desc(boardMappings.confirmedAt))
      .limit(1)
    const row = rows[0]
    if (!row) return null
    // Defensive validation — older rows may have a different shape if
    // schema_version changed; tolerate by parsing through the Zod schema and
    // returning null on failure (caller logs).
    const parsed = BoardMappingSchema.safeParse(row.mappingJson)
    if (!parsed.success) {
      logger.warn(
        { projectId, mappingId: row.mappingId, errs: parsed.error.message },
        'BoardMappingService.get: stored mapping failed schema validation',
      )
      return null
    }
    return parsed.data
  }
}

function actorToString(actor: Actor): string {
  if (actor.type === 'user') return `user:${actor.user_id}`
  if (actor.type === 'system') return `system:${actor.component}`
  if (actor.type === 'persona') return `persona:${actor.persona_id}`
  if (actor.type === 'hook') return `hook:${actor.hook_id}`
  return 'unknown'
}

// SYSTEM_ACTOR_FALLBACK reserved for future use; reference to silence unused warning.
void SYSTEM_ACTOR_FALLBACK

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBoardMappingService(
  db: DB,
  eventStore: EventStore,
  options: DefaultBoardMappingServiceOptions = {},
): BoardMappingService {
  return new DefaultBoardMappingService(db, eventStore, options)
}
