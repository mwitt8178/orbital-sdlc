/**
 * trpc/routers/onboarding.ts — first-run wizard backend.
 *
 * Procedures:
 *   onboarding.status (query)              — install + token presence snapshot
 *   onboarding.setMode (mutation)          — persist 'demo'|'live'|'readonly'
 *   onboarding.connect.anthropic (mut)     — validate + keychain-store API key
 *   onboarding.connect.monday (mutation)   — validate + keychain-store token
 *   onboarding.loadSample (mutation)       — populate Acme demo dataset
 *   onboarding.startDemo (mutation)        — kick off replay loop
 *   onboarding.resetDemo (mutation)        — wipe demo dataset
 *   onboarding.complete (mutation)         — mark setup_completed_at
 *
 * All procedures are publicProcedure (consistent with other routers in this
 * single-tenant local install). Token validation makes real outbound calls
 * to api.anthropic.com and api.monday.com; tokens are stored in the OS
 * keychain only on validation success.
 */

import { TRPCError } from '@trpc/server'
import { router, publicProcedure } from '../init.js'
import { db, sql as sqlPool } from '../../db/client.js'
import { createEventStore } from '../../events/store.js'
import { getKeychain } from '../../capabilities/keychain.js'
import {
  readInstallState,
  setMode as persistMode,
  markSetupCompleted,
} from '../../onboarding/install-state.js'
import {
  setModeInputSchema,
  connectAnthropicInputSchema,
  connectAnthropicOutputSchema,
  connectMondayInputSchema,
  connectMondayOutputSchema,
  loadSampleOutputSchema,
  startDemoInputSchema,
  startDemoOutputSchema,
  resetDemoOutputSchema,
  completeOutputSchema,
  onboardingStatusOutputSchema,
} from '../../onboarding/types.js'
import { getAnthropicValidator } from '../../onboarding/anthropic-validate.js'
import { getMondayValidator } from '../../onboarding/monday-validate.js'
import { createSampleLoader, type SampleLoader } from '../../onboarding/sample-loader.js'
import { createDemoReplayService, type DemoReplayService } from '../../onboarding/demo-replay.js'
import type { Actor } from '@orbital/types'
import { logger } from '../../config/logger.js'

// ---------------------------------------------------------------------------
// Keychain account names
// ---------------------------------------------------------------------------

export const KEYCHAIN_ACCOUNT_ANTHROPIC = 'anthropic.api_key'
export const KEYCHAIN_ACCOUNT_MONDAY = 'monday.api_token'
export const KEYCHAIN_ACCOUNT_MONDAY_BOARD = 'monday.board_id'

// ---------------------------------------------------------------------------
// Lazy singletons
// ---------------------------------------------------------------------------

let _eventStore: ReturnType<typeof createEventStore> | null = null
let _sampleLoader: SampleLoader | null = null
let _replayService: DemoReplayService | null = null

function getEventStore(): ReturnType<typeof createEventStore> {
  if (_eventStore === null) _eventStore = createEventStore(db, sqlPool)
  return _eventStore
}

function getSampleLoader(): SampleLoader {
  if (_sampleLoader === null) _sampleLoader = createSampleLoader(db, getEventStore())
  return _sampleLoader
}

function getReplayService(): DemoReplayService {
  if (_replayService === null) _replayService = createDemoReplayService(db, getEventStore())
  return _replayService
}

const SYSTEM_ACTOR: Actor = { type: 'system', component: 'audit_service' }

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export function createOnboardingRouter() {
  return router({
    // -----------------------------------------------------------------------
    // status
    // -----------------------------------------------------------------------
    status: publicProcedure
      .output(onboardingStatusOutputSchema)
      .query(async () => {
        try {
          const state = await readInstallState()
          const keychain = await getKeychain()
          const [anthropic, monday] = await Promise.all([
            keychain.getPassword(KEYCHAIN_ACCOUNT_ANTHROPIC),
            keychain.getPassword(KEYCHAIN_ACCOUNT_MONDAY),
          ])
          const hasSampleData = state.demoReplayId !== null
          return {
            setupCompletedAt: state.setupCompletedAt,
            mode: state.mode,
            hasAnthropicToken: anthropic !== null && anthropic.length > 0,
            hasMondayToken: monday !== null && monday.length > 0,
            hasSampleData,
            installId: state.installId,
          }
        } catch (err) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Could not read install state',
            cause: err,
          })
        }
      }),

    // -----------------------------------------------------------------------
    // setMode
    // -----------------------------------------------------------------------
    setMode: publicProcedure
      .input(setModeInputSchema)
      .mutation(async ({ input }) => {
        try {
          const next = await persistMode(input.mode)
          await getEventStore().append({
            aggregate_id: next.installId,
            aggregate_type: 'install',
            event_type: 'InstallModeSet',
            payload: { mode: input.mode },
            actor: SYSTEM_ACTOR,
            trace_id: `onboarding-setmode-${next.installId}`,
            occurred_at: new Date().toISOString(),
            schema_version: 1,
          })
          return { mode: next.mode }
        } catch (err) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Could not persist mode',
            cause: err,
          })
        }
      }),

    // -----------------------------------------------------------------------
    // connect
    // -----------------------------------------------------------------------
    connect: router({
      anthropic: publicProcedure
        .input(connectAnthropicInputSchema)
        .output(connectAnthropicOutputSchema)
        .mutation(async ({ input }) => {
          const validator = getAnthropicValidator()
          const result = await validator.validate(input.apiKey)
          if (!result.ok) return result
          try {
            const keychain = await getKeychain()
            await keychain.setPassword(KEYCHAIN_ACCOUNT_ANTHROPIC, input.apiKey)
            const state = await readInstallState()
            await getEventStore().append({
              aggregate_id: state.installId,
              aggregate_type: 'install',
              event_type: 'AnthropicTokenStored',
              payload: { ok: true },
              actor: SYSTEM_ACTOR,
              trace_id: `onboarding-anthropic-${state.installId}`,
              occurred_at: new Date().toISOString(),
              schema_version: 1,
            })
            return { ok: true, balanceCents: result.balanceCents ?? null }
          } catch (err) {
            logger.warn({ err }, 'onboarding.connect.anthropic: keychain write failed')
            return { ok: false, message: 'Validated, but failed to store key in keychain.' }
          }
        }),

      monday: publicProcedure
        .input(connectMondayInputSchema)
        .output(connectMondayOutputSchema)
        .mutation(async ({ input }) => {
          const validator = getMondayValidator()
          const result = await validator.validate(input.apiToken)
          if (!result.ok) return result
          try {
            const keychain = await getKeychain()
            await keychain.setPassword(KEYCHAIN_ACCOUNT_MONDAY, input.apiToken)
            if (input.boardId) {
              await keychain.setPassword(KEYCHAIN_ACCOUNT_MONDAY_BOARD, input.boardId)
            }
            const state = await readInstallState()
            await getEventStore().append({
              aggregate_id: state.installId,
              aggregate_type: 'install',
              event_type: 'MondayTokenStored',
              payload: { ok: true, account_name: result.accountName ?? null },
              actor: SYSTEM_ACTOR,
              trace_id: `onboarding-monday-${state.installId}`,
              occurred_at: new Date().toISOString(),
              schema_version: 1,
            })
            return { ok: true, accountName: result.accountName }
          } catch (err) {
            logger.warn({ err }, 'onboarding.connect.monday: keychain write failed')
            return { ok: false, message: 'Validated, but failed to store token in keychain.' }
          }
        }),
    }),

    // -----------------------------------------------------------------------
    // loadSample
    // -----------------------------------------------------------------------
    loadSample: publicProcedure
      .output(loadSampleOutputSchema)
      .mutation(async () => {
        try {
          return await getSampleLoader().load()
        } catch (err) {
          logger.warn({ err }, 'onboarding.loadSample failed')
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err instanceof Error ? err.message : 'Sample load failed',
            cause: err,
          })
        }
      }),

    // -----------------------------------------------------------------------
    // startDemo
    // -----------------------------------------------------------------------
    startDemo: publicProcedure
      .input(startDemoInputSchema)
      .output(startDemoOutputSchema)
      .mutation(async ({ input }) => {
        try {
          const state = await readInstallState()
          const result = await getReplayService().start({
            installId: state.installId,
            speedMultiplier: input.speedMultiplier,
          })
          return result
        } catch (err) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err instanceof Error ? err.message : 'Demo replay failed to start',
            cause: err,
          })
        }
      }),

    // -----------------------------------------------------------------------
    // resetDemo
    // -----------------------------------------------------------------------
    resetDemo: publicProcedure
      .output(resetDemoOutputSchema)
      .mutation(async () => {
        try {
          const result = await getSampleLoader().reset()
          return {
            cleared: true,
            removedSprints: result.removedSprints,
            removedChannels: result.removedChannels,
          }
        } catch (err) {
          logger.warn({ err }, 'onboarding.resetDemo failed')
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err instanceof Error ? err.message : 'Reset failed',
            cause: err,
          })
        }
      }),

    // -----------------------------------------------------------------------
    // complete
    // -----------------------------------------------------------------------
    complete: publicProcedure
      .output(completeOutputSchema)
      .mutation(async () => {
        try {
          const state = await markSetupCompleted()
          await getEventStore().append({
            aggregate_id: state.installId,
            aggregate_type: 'install',
            event_type: 'OnboardingCompleted',
            payload: {
              install_id: state.installId,
              mode: state.mode,
              completed_at: state.setupCompletedAt,
            },
            actor: SYSTEM_ACTOR,
            trace_id: `onboarding-complete-${state.installId}`,
            occurred_at: new Date().toISOString(),
            schema_version: 1,
          })
          return {
            setupCompletedAt: state.setupCompletedAt!,
            installId: state.installId,
          }
        } catch (err) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Could not mark setup complete',
            cause: err,
          })
        }
      }),
  })
}

export type OnboardingRouter = ReturnType<typeof createOnboardingRouter>

// Lazy singleton — same pattern as the other "factory" routers.
let _router: OnboardingRouter | null = null
export function onboardingRouter(): OnboardingRouter {
  if (_router === null) _router = createOnboardingRouter()
  return _router
}
