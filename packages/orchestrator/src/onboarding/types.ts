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
  hasSampleData: z.boolean(),
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
// loadSample mutation
// ---------------------------------------------------------------------------

export const loadSampleOutputSchema = z.object({
  loaded: z.boolean(),
  alreadyLoaded: z.boolean(),
  visionDocumentId: z.string().nullable(),
  sprintIds: z.array(z.string()),
  channelIds: z.array(z.string()),
  retroReportId: z.string().nullable(),
  eventCount: z.number().int(),
})

// ---------------------------------------------------------------------------
// startDemo mutation
// ---------------------------------------------------------------------------

export const startDemoInputSchema = z.object({
  speedMultiplier: z.number().positive().max(1000).default(10),
})

export const startDemoOutputSchema = z.object({
  replayId: z.string(),
  totalSteps: z.number().int(),
  estimatedDurationMs: z.number().int(),
})

// ---------------------------------------------------------------------------
// resetDemo mutation
// ---------------------------------------------------------------------------

export const resetDemoOutputSchema = z.object({
  cleared: z.boolean(),
  removedSprints: z.number().int(),
  removedChannels: z.number().int(),
})

// ---------------------------------------------------------------------------
// complete mutation
// ---------------------------------------------------------------------------

export const completeOutputSchema = z.object({
  setupCompletedAt: z.string(),
  installId: z.string(),
})
