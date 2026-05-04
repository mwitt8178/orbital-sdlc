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
  /**
   * SCM provider for the project. 'internal' (Orbital-managed CodeCommit) is
   * the default; 'codecommit' is an explicit alias; 'github' delegates to the
   * caller's GitHub-connect flow and skips repo provisioning here.
   * [Engineer-Principal · Opus · run-scm-codecommit]
   */
  scmProvider: z.enum(['internal', 'codecommit', 'github']).optional(),
  ticketProvider: z.enum(['internal', 'monday']).optional(),
})

export type CreateProjectInput = z.infer<typeof CreateProjectInputSchema>

// [Engineer-Principal · Opus · run-settings-general]
//
// /settings/general supports editing name + slug + description + color from the
// General page (save-on-blur). Slug is regex-validated (existing
// projectSlugSchema), color is a free-form theme token capped at 32 chars to
// avoid storing arbitrary CSS strings. All fields optional — patch semantics.
export const RESERVED_PROJECT_SLUGS = [
  'admin',
  'api',
  'app',
  'settings',
  'login',
  'signup',
  'logout',
  'oauth',
  'health',
  'new',
  'create',
  'default',
  'system',
  'orbital',
] as const

export const UpdateProjectInputSchema = z.object({
  projectId: z.string().uuid(),
  name: z.string().min(1).max(120).optional(),
  slug: projectSlugSchema.optional(),
  description: z.string().max(2000).nullable().optional(),
  color: z.string().min(1).max(32).nullable().optional(),
})

export type UpdateProjectInput = z.infer<typeof UpdateProjectInputSchema>

/**
 * Reset clears child aggregate rows for the project (epics, stories, sprints,
 * channels, ceremonies, retros, uat, tasks). The project row itself stays.
 * Requires `confirmName` to match the project's current name to prevent
 * accidental wipes.
 * [Engineer-Principal · Opus · run-settings-general]
 */
export const ResetProjectInputSchema = z.object({
  projectId: z.string().uuid(),
  confirmName: z.string().min(1).max(120),
})

export type ResetProjectInput = z.infer<typeof ResetProjectInputSchema>

/**
 * Hard delete. Admin-role only. Requires confirmName + recoveryEmail captured
 * in the audit event so a follow-up restore is at least correlatable to a
 * human contact.
 * [Engineer-Principal · Opus · run-settings-general]
 */
export const DeleteProjectInputSchema = z.object({
  projectId: z.string().uuid(),
  confirmName: z.string().min(1).max(120),
  recoveryEmail: z.string().email(),
})

export type DeleteProjectInput = z.infer<typeof DeleteProjectInputSchema>

export const ArchiveProjectInputSchema = z.object({
  projectId: z.string().uuid(),
  /** Must equal current project name. */
  confirmName: z.string().min(1).max(120),
})

export type ArchiveProjectInput = z.infer<typeof ArchiveProjectInputSchema>

export const ProjectMetadataInputSchema = z.object({
  projectId: z.string().uuid(),
})

export type ProjectMetadataInput = z.infer<typeof ProjectMetadataInputSchema>

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
  /** SCM repo provisioning failed during project create. */
  SCM_PROVISION_FAILED: 'SCM_PROVISION_FAILED',
  /** Slug is on the reserved list. */
  RESERVED_SLUG: 'RESERVED_SLUG',
  /** Confirm-name typed by the user did not match the project's name. */
  CONFIRM_MISMATCH: 'CONFIRM_MISMATCH',
  /** Caller does not have the required role for this action. */
  FORBIDDEN: 'FORBIDDEN',
} as const

export type ProjectsErrorCode = (typeof PROJECTS_ERROR_CODES)[keyof typeof PROJECTS_ERROR_CODES]
