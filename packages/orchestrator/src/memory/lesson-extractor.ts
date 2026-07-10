/**
 * memory/lesson-extractor.ts — Post-run lesson extraction.
 *
 * [Engineer-Sr · Sonnet · run-memory-prompt-assembly]
 *
 * After each persona run completes, this module makes a small Anthropic API
 * call to extract 1-3 "lessons learned" from the worker's output. Each lesson
 * is written to the project memory as kind='learning', sourceKind='agent',
 * with tags=['auto-lesson', <personaSlug>].
 *
 * The extractor is called from the scheduler's exited handler (post-run),
 * scoped to the task's tenantId + projectId + personaSlug.
 *
 * Design:
 * - Non-blocking: extraction errors are logged but never surface to the caller.
 * - Idempotent: each run produces at most 3 entries; the LLM is instructed
 *   to avoid generic advice and focus on concrete observations.
 * - Cost-aware: uses haiku tier (low-cost, fast).
 * - Real LLM call: never stubs, never returns fake data.
 */

import Anthropic from '@anthropic-ai/sdk'
import { uuidv7 } from 'uuidv7'
import { z } from 'zod'
import type { DB } from '../db/client.js'
import type { EventStore } from '../events/store.js'
import { createMemoryService } from '../memory/service.js'
import { logger } from '../config/logger.js'

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface LessonExtractorParams {
  /** Tenant for scoping all writes. */
  tenantId: string
  /** Project for scoping all writes. */
  projectId: string
  /** Task that just completed. */
  taskId: string
  /** Persona slug (e.g. 'sr-dev', 'pm'). */
  personaSlug: string
  /** Short title of the completed task. */
  taskTitle: string
  /** Full description of the completed task. */
  taskDescription: string
  /**
   * Worker output text (stdout from the claude process).
   * Truncated to 20KB before sending to the LLM.
   */
  workerOutput: string
  /** Drizzle DB instance. */
  db: DB
  /** Event store for audit trail. */
  eventStore: EventStore
  /**
   * Anthropic API key. When absent, extraction is skipped silently.
   * This mirrors the existing driver pattern — loud key check, silent skip.
   */
  anthropicApiKey?: string
}

// ---------------------------------------------------------------------------
// LLM response schema
// ---------------------------------------------------------------------------

const LessonItemSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(2000),
  confidence: z.enum(['low', 'medium', 'high']),
  tags: z.array(z.string().min(1).max(64)).max(5),
})

const LessonsResponseSchema = z.object({
  lessons: z.array(LessonItemSchema).max(3),
})

type LessonsResponse = z.infer<typeof LessonsResponseSchema>

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

const MAX_OUTPUT_CHARS = 20_000
const HAIKU_MODEL = 'claude-haiku-4-5'

/**
 * Extract lessons learned from a completed worker run and write them to memory.
 *
 * This function is fire-and-forget safe — all errors are caught and logged.
 * Returns the number of lessons written (0 if extraction fails or skips).
 */
export async function extractAndStoreLessons(params: LessonExtractorParams): Promise<number> {
  const {
    tenantId,
    projectId,
    taskId,
    personaSlug,
    taskTitle,
    taskDescription,
    workerOutput,
    db,
    eventStore,
    anthropicApiKey,
  } = params

  if (!anthropicApiKey || anthropicApiKey.trim().length === 0) {
    logger.debug(
      { taskId, personaSlug },
      'lesson-extractor: ANTHROPIC_API_KEY not set, skipping lesson extraction',
    )
    return 0
  }

  const truncatedOutput = workerOutput.slice(0, MAX_OUTPUT_CHARS)

  // ---------------------------------------------------------------------------
  // Build the extraction prompt
  // ---------------------------------------------------------------------------

  const systemPrompt = `You are a software engineering knowledge extractor.
Given a completed task and its agent output, extract 0-3 "lessons learned" that would
be valuable to remember for future similar tasks. A lesson must be:
- Specific and actionable (not generic advice like "write tests")
- Based on concrete evidence from the task output
- Novel — do NOT extract lessons that are already obvious conventions

If you find no meaningful lessons, return an empty lessons array.

Return your response using the extract_lessons tool.`

  const userPrompt = `# Completed task: ${taskTitle}

## Description
${taskDescription.slice(0, 2000)}

## Agent output (last ${truncatedOutput.length} chars)
\`\`\`
${truncatedOutput}
\`\`\`

Extract 0-3 specific lessons learned from this run. Focus on:
- Unexpected patterns or pitfalls encountered
- Decisions made and why they worked or didn't
- Conventions discovered in the codebase
- Anti-patterns that should be avoided in similar tasks

Persona that ran this task: ${personaSlug}`

  // ---------------------------------------------------------------------------
  // Anthropic API call (direct — lesson extraction is low-stakes, no routing overhead needed)
  // ---------------------------------------------------------------------------

  let response: LessonsResponse
  try {
    const client = new Anthropic({ apiKey: anthropicApiKey, timeout: 30_000 })

    const result = await client.messages.create({
      model: HAIKU_MODEL,
      max_tokens: 1024,
      system: systemPrompt,
      messages: [{ role: 'user', content: userPrompt }],
      tools: [
        {
          name: 'extract_lessons',
          description: 'Extract lessons learned from the completed task run.',
          input_schema: {
            type: 'object' as const,
            properties: {
              lessons: {
                type: 'array',
                maxItems: 3,
                items: {
                  type: 'object',
                  required: ['title', 'body', 'confidence', 'tags'],
                  properties: {
                    title: { type: 'string', maxLength: 200 },
                    body: { type: 'string', maxLength: 2000 },
                    confidence: { type: 'string', enum: ['low', 'medium', 'high'] },
                    tags: {
                      type: 'array',
                      maxItems: 5,
                      items: { type: 'string', maxLength: 64 },
                    },
                  },
                  additionalProperties: false,
                },
              },
            },
            required: ['lessons'],
            additionalProperties: false,
          },
        },
      ],
      tool_choice: { type: 'tool', name: 'extract_lessons' },
    })

    const toolUseBlock = result.content.find(
      (b): b is Anthropic.Messages.ToolUseBlock =>
        b.type === 'tool_use' && (b as { name: string }).name === 'extract_lessons',
    )
    if (!toolUseBlock) {
      logger.warn({ taskId }, 'lesson-extractor: model did not call extract_lessons tool')
      return 0
    }

    const parsed = LessonsResponseSchema.safeParse(toolUseBlock.input)
    if (!parsed.success) {
      logger.warn({ taskId, error: parsed.error.message }, 'lesson-extractor: response failed validation')
      return 0
    }
    response = parsed.data
  } catch (err) {
    logger.warn({ err, taskId, personaSlug }, 'lesson-extractor: LLM call failed, skipping')
    return 0
  }

  if (response.lessons.length === 0) {
    logger.debug({ taskId, personaSlug }, 'lesson-extractor: no lessons extracted')
    return 0
  }

  // ---------------------------------------------------------------------------
  // Write lessons to memory
  // ---------------------------------------------------------------------------

  const memoryService = createMemoryService(db, eventStore)
  let written = 0

  for (const lesson of response.lessons) {
    try {
      await memoryService.record(
        {
          projectId,
          kind: 'learning',
          title: lesson.title,
          body: lesson.body,
          sourceKind: 'agent',
          sourceId: taskId,
          confidence: lesson.confidence,
          scope: 'project',
          tags: ['auto-lesson', personaSlug, ...lesson.tags],
          links: [{ linkKind: 'task', linkValue: taskId }],
        },
        personaSlug,
        tenantId,
      )
      written++
      logger.info(
        { taskId, personaSlug, lessonTitle: lesson.title, tenantId, projectId },
        'lesson-extractor: lesson written to memory',
      )
    } catch (err) {
      logger.warn({ err, taskId, lessonTitle: lesson.title }, 'lesson-extractor: failed to write lesson')
    }
  }

  // Emit LessonsExtracted event for audit trail (best-effort)
  void eventStore
    .append({
      aggregate_id: taskId,
      aggregate_type: 'task',
      event_type: 'LessonsExtracted',
      payload: {
        task_id: taskId,
        project_id: projectId,
        persona_slug: personaSlug,
        lesson_count: written,
        lessons: response.lessons.map((l) => ({ title: l.title, confidence: l.confidence })),
      },
      actor: { type: 'system', component: 'orchestrator' },
      trace_id: uuidv7(),
      occurred_at: new Date().toISOString(),
      schema_version: 1,
    })
    .catch((err: unknown) => {
      logger.warn({ err, taskId }, 'lesson-extractor: LessonsExtracted event emit failed')
    })

  return written
}
