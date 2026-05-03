/**
 * projects/types.ts — Zod schemas + error codes for the projects bounded
 * context.
 *
 * Per Round 4 Projects Feature spec.
 */

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Slug validation — URL-safe, lowercase letters/digits/hyphens, 2-64 chars
// ---------------------------------------------------------------------------

const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/

export const projectSlugSchema = z
  .string()
  .min(2)
  .max(64)
  .regex(SLUG_PATTERN, 'slug must be lowercase letters, digits, or hyphens (no leading/trailing hyphen)')

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const CreateProjectInputSchema = z.object({
  name: z.string().min(1).max(120),
  slug: projectSlugSchema,
  description: z.string().max(2000).optional(),
  /** Optional: connect Monday board on create. */
  mondayBoardId: z.string().min(1).max(64).optional(),
  /** Optional: connect Github repo on create. */
  githubOwner: z.string().min(1).max(100).optional(),
  githubRepo: z.string().min(1).max(100).optional(),
  githubDefaultBranch: z.string().min(1).max(255).optional(),
  /**
   * Round 9 — onboarding flow A. Captures the operator's intent for the
   * router's provisioner step (the router does the actual Monday + GitHub
   * API calls; this flag is recorded on the ProjectCreated event for audit
   * traceability).
   * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
   */
  provisioning: z
    .object({
      monday: z.boolean().default(false),
      github: z.boolean().default(false),
    })
    .optional(),
})

export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>

export const UpdateProjectInputSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
})

export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>

export const ConnectMondayInputSchema = z.object({
  projectId: z.string().uuid(),
  boardId: z.string().min(1).max(64),
})

export type ConnectMondayInput = z.infer<typeof ConnectMondayInputSchema>

export const ConnectGithubInputSchema = z.object({
  projectId: z.string().uuid(),
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  defaultBranch: z.string().min(1).max(255).default('main'),
})

export type ConnectGithubInput = z.infer<typeof ConnectGithubInputSchema>

// ---------------------------------------------------------------------------
// Output (row-shaped)
// ---------------------------------------------------------------------------

export const ProjectOutputSchema = z.object({
  projectId: z.string().uuid(),
  installId: z.string().uuid(),
  name: z.string(),
  slug: z.string(),
  description: z.string().nullable(),
  mondayBoardId: z.string().nullable(),
  githubOwner: z.string().nullable(),
  githubRepo: z.string().nullable(),
  githubDefaultBranch: z.string(),
  archivedAt: z.string().datetime().nullable(),
  createdByEventId: z.string().uuid().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  schemaVersion: z.number().int(),
})

export type ProjectOutput = z.infer<typeof ProjectOutputSchema>

// ---------------------------------------------------------------------------
// Error codes
// ---------------------------------------------------------------------------

export const PROJECTS_ERROR_CODES = {
  /** Project not found by id. */
  NOT_FOUND_PROJECT: 'NOT_FOUND_PROJECT',
  /** Slug already in use within this install. */
  CONFLICT_SLUG: 'CONFLICT_SLUG',
  /** Active project required by this procedure but missing from request. */
  ACTIVE_PROJECT_REQUIRED: 'ACTIVE_PROJECT_REQUIRED',
  /** Validation error on input. */
  VALIDATION_ERROR: 'VALIDATION_ERROR',
  /** Internal DB error. */
  INTERNAL_DB_ERROR: 'INTERNAL_DB_ERROR',
  /** Monday board connect failed (board not found / wrong permissions). */
  MONDAY_CONNECT_FAILED: 'MONDAY_CONNECT_FAILED',
  /** Github repo connect failed (repo not found / wrong permissions). */
  GITHUB_CONNECT_FAILED: 'GITHUB_CONNECT_FAILED',
} as const

export type ProjectsErrorCode = (typeof PROJECTS_ERROR_CODES)[keyof typeof PROJECTS_ERROR_CODES]
