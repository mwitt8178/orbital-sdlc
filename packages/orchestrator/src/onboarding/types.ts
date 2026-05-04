/**
 * onboarding/types.ts — input/output shapes for the onboarding tRPC router.
 */

import { z } from 'zod'
import { onboardingModeSchema } from './install-state.js'

export type { OnboardingMode } from './install-state.js'

// ---------------------------------------------------------------------------
// status query
// ---------------------------------------------------------------------------

export const onboardingStatusOutputSchema = z.object({
  setupCompletedAt: z.string().nullable(),
  mode: onboardingModeSchema.nullable(),
  hasAnthropicToken: z.boolean(),
  hasMondayToken: z.boolean(),
  installId: z.string(),
})

export type OnboardingStatus = z.infer<typeof onboardingStatusOutputSchema>

// ---------------------------------------------------------------------------
// setMode mutation
// ---------------------------------------------------------------------------

export const setModeInputSchema = z.object({
  mode: onboardingModeSchema,
})

// ---------------------------------------------------------------------------
// connect.anthropic mutation
// ---------------------------------------------------------------------------

export const connectAnthropicInputSchema = z.object({
  apiKey: z.string().min(1).max(512),
})

export const connectAnthropicOutputSchema = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  /** Best-effort balance hint. Anthropic does not expose balance via SDK; we
   *  return undefined here. UI should treat as "Connected" without amount. */
  balanceCents: z.number().int().nullable().optional(),
})

export type ConnectAnthropicResult = z.infer<typeof connectAnthropicOutputSchema>

// ---------------------------------------------------------------------------
// connect.monday mutation
// ---------------------------------------------------------------------------

export const connectMondayInputSchema = z.object({
  apiToken: z.string().min(1).max(2048),
  boardId: z.string().min(1).max(64).optional(),
})

export const connectMondayOutputSchema = z.object({
  ok: z.boolean(),
  message: z.string().optional(),
  accountName: z.string().optional(),
})

export type ConnectMondayResult = z.infer<typeof connectMondayOutputSchema>

// ---------------------------------------------------------------------------
// complete mutation
// ---------------------------------------------------------------------------

export const completeOutputSchema = z.object({
  setupCompletedAt: z.string(),
  installId: z.string(),
})

// ---------------------------------------------------------------------------
// Round 9 — Onboarding UX Overhaul
// [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
// ---------------------------------------------------------------------------

export const onboardingFlowSchema = z.enum(['new_project', 'existing_repo', 'join_hub'])
export type OnboardingFlowKind = z.infer<typeof onboardingFlowSchema>

// startSession ------------------------------------------------------

export const startSessionInputSchema = z.object({
  flow: onboardingFlowSchema,
})

export const sessionRowSchema = z.object({
  sessionId: z.string().uuid(),
  installId: z.string().uuid(),
  flow: onboardingFlowSchema,
  currentStep: z.string(),
  status: z.enum(['active', 'completed', 'abandoned']),
  stateJson: z.record(z.unknown()),
  projectId: z.string().uuid().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
  abandonedAt: z.string().nullable(),
})

export const startSessionOutputSchema = sessionRowSchema

// resume ------------------------------------------------------------

export const resumeOutputSchema = z.object({
  session: sessionRowSchema.nullable(),
})

// updateSession -----------------------------------------------------

export const updateSessionInputSchema = z.object({
  sessionId: z.string().uuid(),
  step: z.string().optional(),
  patch: z.record(z.unknown()).optional(),
})

export const updateSessionOutputSchema = sessionRowSchema

// abandonSession ----------------------------------------------------

export const abandonSessionInputSchema = z.object({
  sessionId: z.string().uuid(),
  reason: z.string().min(1).max(200),
})

export const abandonSessionOutputSchema = sessionRowSchema

// createMondayBoard -------------------------------------------------

export const createMondayBoardInputSchema = z.object({
  sessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  projectName: z.string().min(1).max(120),
  workspaceId: z.string().min(1).max(64).nullable().optional(),
  isPrivate: z.boolean().optional(),
})

export const createMondayBoardOutputSchema = z.object({
  boardId: z.string(),
  boardUrl: z.string(),
  workspaceId: z.string().nullable(),
  columnsAdded: z.number().int(),
  statusValuesAdded: z.number().int(),
  columnIdsByCanonical: z.record(z.string()),
})

// createGitRepo -----------------------------------------------------

export const createGitRepoInputSchema = z.object({
  sessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  name: z
    .string()
    .min(1)
    .max(100)
    .regex(/^[A-Za-z0-9._-]+$/, 'GitHub repo names allow letters, digits, ., _, -'),
  org: z.string().min(1).max(100).nullable().optional(),
  description: z.string().max(2000).optional(),
  isPrivate: z.boolean().optional(),
  stack: z.enum(['nodejs', 'go', 'python', 'generic']).optional(),
  license: z.enum(['mit', 'apache-2.0', 'unlicense']).nullable().optional(),
  webhookUrl: z.string().url().nullable().optional(),
  webhookSecret: z.string().min(8).max(256).nullable().optional(),
})

export const createGitRepoOutputSchema = z.object({
  owner: z.string(),
  repo: z.string(),
  htmlUrl: z.string(),
  defaultBranch: z.string(),
  isPrivate: z.boolean(),
  ciWorkflowCommitted: z.boolean(),
  webhookConfigured: z.boolean(),
  labelsCreated: z.array(z.string()),
})

// estimateAnalyzeCodebase + analyzeCodebase -------------------------

export const estimateAnalyzeCodebaseInputSchema = z.object({
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
})

export const estimateAnalyzeCodebaseOutputSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  costUsd: z.number(),
  plan: z.string(),
})

export const analyzeCodebaseInputSchema = z.object({
  sessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  owner: z.string().min(1).max(100),
  repo: z.string().min(1).max(100),
  useLLM: z.boolean().optional(),
})

export const analyzeCodebaseOutputSchema = z.object({
  stack: z.array(z.string()),
  testRunner: z.string().nullable(),
  ciWorkflowCount: z.number().int(),
  ciWorkflows: z.array(z.string()),
  commitConvention: z.string().nullable(),
  branchModel: z.string().nullable(),
  readmeSummary: z.string().nullable(),
  adrCount: z.number().int(),
  llmCostUsd: z.number(),
  inferredMemoryEntries: z.array(
    z.object({
      kind: z.enum(['decision', 'convention', 'glossary', 'learning', 'anti_pattern']),
      title: z.string(),
      body: z.string(),
      tags: z.array(z.string()),
      source: z
        .object({
          kind: z.enum(['adr', 'readme', 'pr', 'file']),
          ref: z.string(),
        })
        .optional(),
    }),
  ),
  llmUsed: z.boolean(),
})

// seedMemory --------------------------------------------------------

export const seedMemoryFromAnalysisInputSchema = z.object({
  sessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  report: analyzeCodebaseOutputSchema,
})

export const seedMemoryFromVisionInputSchema = z.object({
  sessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  intent: z.string().min(1).max(20_000),
  stack: z.array(z.string()).default([]),
  conventions: z
    .array(z.object({ title: z.string(), body: z.string() }))
    .default([]),
  glossary: z
    .array(z.object({ term: z.string(), definition: z.string() }))
    .default([]),
})

export const seedMemoryOutputSchema = z.object({
  entryIds: z.array(z.string().uuid()),
  countsByKind: z.record(z.number().int()),
})

// configureSystem ---------------------------------------------------

export const configureSystemInputSchema = z.object({
  sessionId: z.string().uuid(),
  projectId: z.string().uuid(),
  projectName: z.string().min(1).max(120),
  github: z
    .object({
      owner: z.string().min(1).max(100),
      repo: z.string().min(1).max(100),
    })
    .nullable()
    .optional(),
  vision: z
    .object({
      intent: z.string(),
      stack: z.array(z.string()),
    })
    .optional(),
  analysis: z
    .object({
      stack: z.array(z.string()),
      testRunner: z.string().nullable(),
      commitConvention: z.string().nullable(),
      branchModel: z.string().nullable(),
    })
    .optional(),
  mondayBoardId: z.string().nullable().optional(),
  memoryEntryIds: z.array(z.string().uuid()).default([]),
  skills: z.array(z.string()).optional(),
})

export const configureSystemOutputSchema = z.object({
  claudeMdCommitted: z.boolean(),
  claudeMdSha: z.string().nullable(),
  skillsEnabled: z.array(z.string()),
  skillsConfigPath: z.string(),
})

// completeFlow ------------------------------------------------------

export const completeFlowInputSchema = z.object({
  sessionId: z.string().uuid(),
  projectId: z.string().uuid().nullable().optional(),
})

export const completeFlowOutputSchema = sessionRowSchema
