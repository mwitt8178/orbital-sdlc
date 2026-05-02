/**
 * MCP tool: vision.read
 *
 * Per TRD-01 §6.2.
 *
 * Returns the current locked (or latest draft) vision document for the given
 * vision_document_id. Required scope: board_read on
 * ticket:vision_document:{id}.
 *
 * Error codes:
 *   AUTH_SCOPE_DENIED  — bundle missing board_read scope on vision:*
 *   NOT_FOUND_VISION_DOCUMENT — unknown document_id
 */

import { z } from 'zod'
import { OrbitalError } from '@orbital/types'
import type { MCPTool, ToolContext } from '../registry.js'
import { eq } from 'drizzle-orm'
import { visionDocuments, visionVersions } from '../../db/schema/vision.js'

const VisionReadInputSchema = z.object({
  vision_document_id: z.string().uuid(),
})

const VisionReadOutputSchema = z.object({
  vision_document_id: z.string(),
  current_content: z.record(z.any()),
  current_version_number: z.number().int().nonnegative(),
  is_locked: z.boolean(),
  open_questions: z.array(z.record(z.any())),
  pending_user_message: z.string().optional(),
})

export const visionReadTool: MCPTool<
  typeof VisionReadInputSchema,
  typeof VisionReadOutputSchema
> = {
  name: 'vision.read',
  description:
    'Read the current (locked or draft) vision document. Requires board_read scope on ticket:vision_document:{id}. Returns AUTH_SCOPE_DENIED if scope is missing.',
  inputSchema: VisionReadInputSchema,
  outputSchema: VisionReadOutputSchema,
  // We handle scope check manually inside the handler so we can return the
  // domain-specific AUTH_SCOPE_DENIED code rather than the generic gateway error.
  bypassScopeCheck: true,

  async handler(input, ctx: ToolContext) {
    const { vision_document_id } = input
    const { db, bundle } = ctx

    // Capability gate: board_read scope on ticket:vision_document:{id}
    // Per TRD-01 §6.2: missing scope → AUTH_SCOPE_DENIED
    const requiredResource = `ticket:vision_document:${vision_document_id}`
    const hasScope =
      Array.isArray(bundle.scopes?.board_read) &&
      bundle.scopes.board_read.some(
        (pattern: string) =>
          pattern === '*' ||
          pattern === requiredResource ||
          pattern === 'ticket:vision_document:*' ||
          pattern === `ticket:vision_document:${vision_document_id}`,
      )

    if (!hasScope) {
      throw new OrbitalError(
        'AUTH_SCOPE_DENIED',
        `vision.read requires board_read scope on '${requiredResource}'. ` +
          `Bundle has: ${JSON.stringify(bundle.scopes?.board_read ?? [])}`,
        { required_scope: 'board_read', required_resource: requiredResource },
        'no_retry',
      )
    }

    // Fetch document
    const docRows = await db
      .select()
      .from(visionDocuments)
      .where(eq(visionDocuments.visionDocumentId, vision_document_id))
      .limit(1)

    const doc = docRows[0]
    if (!doc) {
      throw new OrbitalError(
        'NOT_FOUND_VISION_DOCUMENT',
        `Vision document ${vision_document_id} not found.`,
        { vision_document_id },
        'no_retry',
      )
    }

    // Fetch current version
    if (!doc.currentVersionId) {
      // No version yet — return empty shell
      return {
        vision_document_id,
        current_content: { schema_version: 1, title: doc.title },
        current_version_number: 0,
        is_locked: false,
        open_questions: [],
      }
    }

    const vRows = await db
      .select()
      .from(visionVersions)
      .where(eq(visionVersions.visionVersionId, doc.currentVersionId))
      .limit(1)

    const v = vRows[0]
    if (!v) {
      throw new OrbitalError(
        'NOT_FOUND_VISION_VERSION',
        `Version ${doc.currentVersionId} not found.`,
        {},
        'no_retry',
      )
    }

    const content = v.content as Record<string, unknown>
    const openQuestions = Array.isArray(content['open_questions'])
      ? (content['open_questions'] as Array<Record<string, unknown>>)
      : []

    return {
      vision_document_id,
      current_content: content,
      current_version_number: v.versionNumber,
      is_locked: v.isLocked === 1,
      open_questions: openQuestions,
    }
  },
}
