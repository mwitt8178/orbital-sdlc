/**
 * onboarding/monday-provisioner.ts — creates a fully-configured Monday board
 * via the Monday GraphQL API.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * The canonical column set follows the `sdlc-monday-board` skill:
 *   - Workflow Status (Status)
 *   - Risk Tier (Status)
 *   - Estimate (Status)
 *   - Author (People)
 *   - Reviewer (People)
 *   - QA Tester (People)
 *   - Acceptance Criteria (Long Text)
 *   - Confidence (Numbers)
 *   - Token Cost (Numbers)
 *   - PR Link (Link)
 *   - Rollback Plan (Long Text)
 *   - SOC 2 Controls (Status)
 *
 * On success:
 *   1. Persists the column-id-to-canonical-concept mapping into board_mappings
 *      so personas can use the new board immediately.
 *   2. Emits MondayBoardProvisioned event.
 *
 * Real Monday API calls only — no mocks in src/. The MondayClient handles
 * 5xx retries / 429 backoff / 401 auth errors uniformly.
 */

import { uuidv7 } from 'uuidv7'
import type { Actor } from '@orbital/types'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import type { MondayClient } from '../backlog/monday-client.js'
import { boardMappings } from '../db/schema/board-mapping.js'
import type { MondayBoardProvisionedPayload } from '../events/types.js'
import { logger } from '../config/logger.js'

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'orchestrator' }

// ---------------------------------------------------------------------------
// Canonical column definitions
// ---------------------------------------------------------------------------

/**
 * Monday column "type" identifiers per their GraphQL schema (2024-01).
 * Only the column types we actually emit are listed.
 */
type MondayColumnTypeId =
  | 'status'
  | 'people'
  | 'long_text'
  | 'numbers'
  | 'link'

interface CanonicalColumnSpec {
  /** Stable canonical key — used for board_mappings lookup. */
  canonical: string
  /** Title shown in the Monday UI. */
  title: string
  /** Monday column type. */
  type: MondayColumnTypeId
  /** For status columns, the labels to seed. */
  labels?: string[]
}

export const CANONICAL_COLUMNS: CanonicalColumnSpec[] = [
  {
    canonical: 'workflow_status',
    title: 'Workflow Status',
    type: 'status',
    labels: [
      'M0 Backlog',
      'M1 Specced',
      'M2 Ready',
      'M3 In Progress',
      'M4 In Review',
      'M5 QA',
      'M6 Approved',
      'M7 Deployed',
      'M8 Closed',
    ],
  },
  {
    canonical: 'risk_tier',
    title: 'Risk Tier',
    type: 'status',
    labels: ['Low', 'Medium', 'High', 'Critical'],
  },
  {
    canonical: 'estimate',
    title: 'Estimate',
    type: 'status',
    labels: ['XS', 'S', 'M', 'L', 'XL'],
  },
  { canonical: 'author', title: 'Author', type: 'people' },
  { canonical: 'reviewer', title: 'Reviewer', type: 'people' },
  { canonical: 'qa_tester', title: 'QA Tester', type: 'people' },
  { canonical: 'acceptance_criteria', title: 'Acceptance Criteria', type: 'long_text' },
  { canonical: 'confidence', title: 'Confidence', type: 'numbers' },
  { canonical: 'token_cost', title: 'Token Cost', type: 'numbers' },
  { canonical: 'pr_link', title: 'PR Link', type: 'link' },
  { canonical: 'rollback_plan', title: 'Rollback Plan', type: 'long_text' },
  {
    canonical: 'soc2_controls',
    title: 'SOC 2 Controls',
    type: 'status',
    labels: ['CC1', 'CC2', 'CC3', 'CC4', 'CC5', 'CC6', 'CC7', 'CC8'],
  },
]

// ---------------------------------------------------------------------------
// Service interface
// ---------------------------------------------------------------------------

export interface ProvisionMondayBoardInput {
  sessionId: string
  projectId: string
  projectName: string
  /** Optional Monday workspace id. Falls back to the user's main workspace. */
  workspaceId?: string | null
  /** Whether the board should be private. */
  isPrivate?: boolean
}

export interface ProvisionMondayBoardResult {
  boardId: string
  boardUrl: string
  workspaceId: string | null
  columnsAdded: number
  statusValuesAdded: number
  /** column canonical → Monday column id map (mirror of board_mappings.mapping_json). */
  columnIdsByCanonical: Record<string, string>
}

export interface MondayProvisioner {
  provision(input: ProvisionMondayBoardInput): Promise<ProvisionMondayBoardResult>
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

interface CreateBoardResp {
  create_board: {
    id: string
    name: string
    url?: string | null
    workspace?: { id: string | null } | null
  }
}

interface CreateColumnResp {
  create_column: {
    id: string
    title: string
    type: string
  }
}

export class DefaultMondayProvisioner implements MondayProvisioner {
  constructor(
    private readonly db: DB,
    private readonly eventStore: EventStore,
    private readonly client: MondayClient,
  ) {}

  async provision(input: ProvisionMondayBoardInput): Promise<ProvisionMondayBoardResult> {
    const boardName = `${input.projectName} — SDLC`
    const boardKind = input.isPrivate ? 'private' : 'public'

    // Step 1: create the board.
    const createBoardQuery = `mutation($name: String!, $kind: BoardKind!, $workspace_id: ID) {
      create_board(board_name: $name, board_kind: $kind, workspace_id: $workspace_id) {
        id
        name
        url
        workspace { id }
      }
    }`

    const variables: Record<string, unknown> = {
      name: boardName,
      kind: boardKind,
    }
    if (input.workspaceId) variables['workspace_id'] = input.workspaceId

    const createResp = await this.client.graphql<CreateBoardResp>(createBoardQuery, variables)
    const board = createResp.create_board
    if (!board || !board.id) {
      throw new Error('Monday create_board returned no board id')
    }

    const boardId = String(board.id)
    const boardUrl =
      board.url ?? `https://view.monday.com/boards/${encodeURIComponent(boardId)}`
    const workspaceId = board.workspace?.id ? String(board.workspace.id) : null

    // Step 2: add canonical columns one-by-one. Monday's create_column does not
    // accept a batch shape, so we call once per column and aggregate.
    const columnIdsByCanonical: Record<string, string> = {}
    let statusValuesAdded = 0

    for (const spec of CANONICAL_COLUMNS) {
      const defaultsBlob =
        spec.type === 'status' && spec.labels && spec.labels.length > 0
          ? JSON.stringify({
              labels: Object.fromEntries(spec.labels.map((label, idx) => [String(idx + 1), label])),
            })
          : null

      const createColumnQuery = `mutation($board_id: ID!, $title: String!, $type: ColumnType!, $defaults: JSON) {
        create_column(board_id: $board_id, title: $title, column_type: $type, defaults: $defaults) {
          id
          title
          type
        }
      }`

      try {
        const colResp = await this.client.graphql<CreateColumnResp>(createColumnQuery, {
          board_id: boardId,
          title: spec.title,
          type: spec.type,
          defaults: defaultsBlob,
        })
        const colId = colResp.create_column?.id
        if (!colId) {
          logger.warn(
            { boardId, title: spec.title, canonical: spec.canonical },
            'Monday create_column returned no id; skipping mapping entry',
          )
          continue
        }
        columnIdsByCanonical[spec.canonical] = String(colId)
        if (spec.labels) statusValuesAdded += spec.labels.length
      } catch (err) {
        // One column failure does not abort the provisioning — log and continue
        // so the board is at least usable. The canonical mapping records only
        // the columns that succeeded.
        logger.warn(
          {
            err: err instanceof Error ? err.message : String(err),
            boardId,
            title: spec.title,
          },
          'Monday create_column failed; continuing with remaining columns',
        )
      }
    }

    const columnsAdded = Object.keys(columnIdsByCanonical).length

    // Step 3: persist mapping_json so personas can use the new board.
    const mappingJson = {
      version: 1,
      provenance: 'monday_provisioner_round9',
      columns: columnIdsByCanonical,
      // Round 5 board mapping shape compatibility — keep "canonical → column_id"
      // direct lookup as the source of truth.
    }

    const now = new Date()
    let mappingPersisted = false
    try {
      await this.db.insert(boardMappings).values({
        mappingId: uuidv7(),
        projectId: input.projectId,
        boardId,
        mappingJson,
        proposedAt: now,
        confirmedAt: now,
        confirmedBy: 'monday_provisioner',
        schemaVersion: 1,
      })
      mappingPersisted = true
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err), boardId, projectId: input.projectId },
        'board_mappings insert failed; persona writes may fall back to heuristic mapping',
      )
    }

    // Step 4: emit event.
    const payload: MondayBoardProvisionedPayload = {
      session_id: input.sessionId,
      project_id: input.projectId,
      monday_board_id: boardId,
      monday_board_url: boardUrl,
      workspace_id: workspaceId,
      columns_added: columnsAdded,
      status_values_added: statusValuesAdded,
      mapping_persisted: mappingPersisted,
      provisioned_at: now.toISOString(),
    }
    await this.eventStore.append({
      aggregate_id: input.projectId,
      aggregate_type: 'install',
      event_type: 'MondayBoardProvisioned',
      payload: payload as unknown as Record<string, unknown>,
      actor: SYSTEM_ACTOR,
      trace_id: uuidv7(),
      occurred_at: now.toISOString(),
      schema_version: 1,
    })

    return {
      boardId,
      boardUrl,
      workspaceId,
      columnsAdded,
      statusValuesAdded,
      columnIdsByCanonical,
    }
  }
}

export function createMondayProvisioner(
  db: DB,
  eventStore: EventStore,
  client: MondayClient,
): MondayProvisioner {
  return new DefaultMondayProvisioner(db, eventStore, client)
}
