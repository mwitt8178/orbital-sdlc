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
import { z } from 'zod';
import type { Actor } from '@orbital/types';
import type { DB } from '@orbital/db';
import type { EventStore } from '../events/store.js';
import type { BoardSchema } from './board-discovery.js';
import type { AnthropicDriver, DriverPersonaSlug } from '../../../orchestrator/src/personas/anthropic-driver.js';
export declare const ORBITAL_STATES: readonly ["backlog", "ready", "in_progress", "in_review", "done", "accepted", "defective"];
export type OrbitalState = (typeof ORBITAL_STATES)[number];
export type StoryPointsUnit = 'story_points' | 'hours' | 't_shirt' | 'none';
export interface BoardMapping {
    board_id: string;
    project_id: string;
    /** The Monday column we treat as the lifecycle state. NULL = no mapping. */
    status_column_id: string | null;
    /**
     * Mapping from Monday status label TEXT (case-insensitive match) to Orbital
     * state. Empty when status_column_id is null. Labels not in this dict are
     * treated as 'backlog' by the resolver (with a warning log).
     */
    status_label_to_state: Record<string, OrbitalState>;
    estimate_column_id: string | null;
    priority_column_id: string | null;
    /** When AC lives in a text/long-text column on the parent item. */
    ac_column_id: string | null;
    /**
     * When AC lives in subitems (each AC = a subitem). The subitem template id
     * is the "parent column id" used to attach subitems on creation. Either
     * `ac_column_id` OR `ac_subitem_template_id` is set, never both.
     */
    ac_subitem_template_id: string | null;
    assignee_column_id: string | null;
    story_points_unit: StoryPointsUnit;
    /**
     * What the team calls these objects. Defaults to canonical names. We surface
     * these in persona prompts so generated comments use the team's vocabulary.
     */
    monday_terminology: {
        epic: string;
        story: string;
        task: string;
        sprint: string;
    };
    /** ISO timestamp when the user (or system) confirmed the mapping. */
    confirmed_at: string | null;
    confirmed_by: string | null;
}
export declare const BoardMappingSchema: z.ZodObject<{
    board_id: z.ZodString;
    project_id: z.ZodString;
    status_column_id: z.ZodNullable<z.ZodString>;
    status_label_to_state: z.ZodRecord<z.ZodString, z.ZodEnum<["backlog", "ready", "in_progress", "in_review", "done", "accepted", "defective"]>>;
    estimate_column_id: z.ZodNullable<z.ZodString>;
    priority_column_id: z.ZodNullable<z.ZodString>;
    ac_column_id: z.ZodNullable<z.ZodString>;
    ac_subitem_template_id: z.ZodNullable<z.ZodString>;
    assignee_column_id: z.ZodNullable<z.ZodString>;
    story_points_unit: z.ZodEnum<["story_points", "hours", "t_shirt", "none"]>;
    monday_terminology: z.ZodObject<{
        epic: z.ZodString;
        story: z.ZodString;
        task: z.ZodString;
        sprint: z.ZodString;
    }, "strip", z.ZodTypeAny, {
        task: string;
        sprint: string;
        epic: string;
        story: string;
    }, {
        task: string;
        sprint: string;
        epic: string;
        story: string;
    }>;
    confirmed_at: z.ZodNullable<z.ZodString>;
    confirmed_by: z.ZodNullable<z.ZodString>;
}, "strip", z.ZodTypeAny, {
    project_id: string;
    board_id: string;
    confirmed_at: string | null;
    confirmed_by: string | null;
    status_column_id: string | null;
    status_label_to_state: Record<string, "done" | "in_progress" | "ready" | "backlog" | "in_review" | "accepted" | "defective">;
    estimate_column_id: string | null;
    priority_column_id: string | null;
    ac_column_id: string | null;
    ac_subitem_template_id: string | null;
    assignee_column_id: string | null;
    story_points_unit: "none" | "story_points" | "hours" | "t_shirt";
    monday_terminology: {
        task: string;
        sprint: string;
        epic: string;
        story: string;
    };
}, {
    project_id: string;
    board_id: string;
    confirmed_at: string | null;
    confirmed_by: string | null;
    status_column_id: string | null;
    status_label_to_state: Record<string, "done" | "in_progress" | "ready" | "backlog" | "in_review" | "accepted" | "defective">;
    estimate_column_id: string | null;
    priority_column_id: string | null;
    ac_column_id: string | null;
    ac_subitem_template_id: string | null;
    assignee_column_id: string | null;
    story_points_unit: "none" | "story_points" | "hours" | "t_shirt";
    monday_terminology: {
        task: string;
        sprint: string;
        epic: string;
        story: string;
    };
}>;
export interface BoardMappingProposeOptions {
    /** Override project_id; if not provided, the schema's mapping is project-less. */
    projectId: string;
}
export interface BoardMappingService {
    /**
     * Propose a mapping given a discovered schema. Heuristic-first; refines
     * via the LLM if AnthropicDriver is configured. The proposal is NOT
     * persisted — caller must call confirm() to persist.
     */
    propose(schema: BoardSchema, options: BoardMappingProposeOptions): Promise<BoardMapping>;
    /**
     * Persist a mapping with confirmed_at = now(). Idempotent on
     * (project_id, board_id) — re-confirming overwrites the existing row.
     * Emits BoardMappingConfirmed.
     */
    confirm(mapping: BoardMapping, actor: Actor): Promise<void>;
    /**
     * Read the active confirmed mapping for a project. Returns null when no
     * mapping has been confirmed.
     */
    get(projectId: string): Promise<BoardMapping | null>;
}
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
export declare function heuristicMap(schema: BoardSchema, options: {
    projectId: string;
}): BoardMapping;
/**
 * Match a Monday status label (e.g. "Working on it", "Done", "Stuck") to one
 * of our canonical states using fuzzy substring matching. Returns 'backlog'
 * as a safe default when no rule fires.
 */
export declare function matchLabelToState(label: string): OrbitalState;
/**
 * Prompt template for the LLM mapping refinement step. The driver enforces
 * structured output via tool-use against BoardMappingSchema, so the LLM cannot
 * hallucinate keys or types — it can only refine values.
 *
 * Cost: ~$0.001 per call on Haiku. We use Haiku via riskClass='low'.
 */
export declare const LLM_MAPPING_SYSTEM_PROMPT = "You are mapping a Monday.com board to canonical SDLC concepts for an autonomous engineering platform.\n\nGiven a BoardSchema (the discovered shape of a Monday board) and a heuristic baseline mapping, refine the mapping so it matches what a real user of this board would consider correct. Specifically:\n\n- Pick the STATUS column that drives lifecycle (look at column titles, types, and sample values; prefer the column actually used as the workflow state).\n- For each status label, pick the closest Orbital state from this enum: backlog, ready, in_progress, in_review, done, accepted, defective.\n- Identify the ESTIMATE column (story points, hours, or t-shirt size) and set story_points_unit.\n- Identify the PRIORITY column.\n- Decide where Acceptance Criteria live: a long-text column on the parent item (set ac_column_id) OR each AC as a subitem (set ac_subitem_template_id to the subitem column id, or 'name' if the subitem name itself is the AC). Set the unused field to null.\n- Identify the ASSIGNEE column (a 'people' column).\n- Use the team's vocabulary in monday_terminology (e.g. \"initiative\" instead of \"epic\", \"feature\" instead of \"story\") if the column titles reveal a different convention.\n\nAlways return all required fields. Set fields to null when you cannot make a confident pick. Use board_id and project_id from the input verbatim. confirmed_at and confirmed_by must be null in the proposal.";
/**
 * Build the user prompt for the LLM mapping call.
 */
export declare function buildLlmUserPrompt(schema: BoardSchema, baseline: BoardMapping): string;
export interface DefaultBoardMappingServiceOptions {
    /** Optional AnthropicDriver for LLM refinement. */
    driver?: AnthropicDriver | null;
    /** Optional install id for cost reporting. */
    installId?: string;
    /** Persona used in the driver call (default 'pm'). */
    driverPersona?: DriverPersonaSlug;
}
export declare class DefaultBoardMappingService implements BoardMappingService {
    private readonly db;
    private readonly eventStore;
    private readonly driver;
    private readonly driverPersona;
    constructor(db: DB, eventStore: EventStore, options?: DefaultBoardMappingServiceOptions);
    propose(schema: BoardSchema, options: BoardMappingProposeOptions): Promise<BoardMapping>;
    confirm(mapping: BoardMapping, actor: Actor): Promise<void>;
    get(projectId: string): Promise<BoardMapping | null>;
}
export declare function createBoardMappingService(db: DB, eventStore: EventStore, options?: DefaultBoardMappingServiceOptions): BoardMappingService;
//# sourceMappingURL=board-mapping.d.ts.map