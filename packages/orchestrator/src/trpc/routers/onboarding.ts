/**
 * trpc/routers/onboarding.ts — first-run wizard backend.
 *
 * Procedures:
 *   onboarding.status (query)              — install + token presence snapshot
 *   onboarding.setMode (mutation)          — persist 'live'|'readonly'
 *   onboarding.connect.anthropic (mut)     — validate + keychain-store API key
 *   onboarding.connect.monday (mutation)   — validate + keychain-store token
 *   onboarding.complete (mutation)         — mark setup_completed_at
 *
 * Round 9 — Onboarding UX Overhaul procedures:
 *   onboarding.startSession              — open a wizard session (NEW PROJECT/EXISTING/JOIN)
 *   onboarding.resume                    — find latest active session (refresh = same step)
 *   onboarding.updateSession             — advance step OR write patch to state_json
 *   onboarding.abandonSession            — explicit cancel; emits OnboardingAbandoned
 *   onboarding.completeSession           — mark complete; emits OnboardingCompleted
 *   onboarding.createMondayBoard         — provision a fresh Monday board
 *   onboarding.createGitRepo             — provision a fresh GitHub repo
 *   onboarding.estimateAnalyzeCodebase   — pre-flight cost estimate (Flow B)
 *   onboarding.analyzeCodebase           — static + LLM analysis (Flow B)
 *   onboarding.seedMemoryFromAnalysis    — seed memory from analyzer report
 *   onboarding.seedMemoryFromVision      — seed memory from vision intake
 *   onboarding.configureSystem           — generate CLAUDE.md + skill bundle
 *
 * All procedures are publicProcedure (consistent with other routers in this
 * single-tenant local install). Token validation makes real outbound calls
 * to api.anthropic.com and api.monday.com; tokens are stored in the OS
 * keychain only on validation success.
 *
 * Round 9 — Onboarding UX Overhaul
 * [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
 *
 * Round 11 — sample/demo flow removal
 * [Engineer-Principal · Opus · run-remove-sample-flow]
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
  completeOutputSchema,
  onboardingStatusOutputSchema,
  connectGithubInputSchema,
  connectGithubOutputSchema,
  listGithubReposInputSchema,
  listGithubReposOutputSchema,
  // Round 9 schemas
  startSessionInputSchema,
  startSessionOutputSchema,
  resumeOutputSchema,
  updateSessionInputSchema,
  updateSessionOutputSchema,
  abandonSessionInputSchema,
  abandonSessionOutputSchema,
  createMondayBoardInputSchema,
  createMondayBoardOutputSchema,
  createGitRepoInputSchema,
  createGitRepoOutputSchema,
  estimateAnalyzeCodebaseInputSchema,
  estimateAnalyzeCodebaseOutputSchema,
  analyzeCodebaseInputSchema,
  analyzeCodebaseOutputSchema,
  seedMemoryFromAnalysisInputSchema,
  seedMemoryFromVisionInputSchema,
  seedMemoryOutputSchema,
  configureSystemInputSchema,
  configureSystemOutputSchema,
  completeFlowInputSchema,
  completeFlowOutputSchema,
} from '../../onboarding/types.js'
import { getAnthropicValidator } from '../../onboarding/anthropic-validate.js'
import { getMondayValidator } from '../../onboarding/monday-validate.js'
import { getGithubValidator } from '../../onboarding/github-validate.js'
import {
  createOnboardingFlowService,
  type OnboardingFlowService,
} from '../../onboarding/flows.js'
import {
  createMondayProvisioner,
  type MondayProvisioner,
} from '../../onboarding/monday-provisioner.js'
import {
  createGithubProvisioner,
  type DefaultGithubProvisioner,
  type LowLevelGithubRequest,
} from '../../onboarding/github-provisioner.js'
import {
  createCodebaseAnalyzer,
  type CodebaseAnalyzer,
} from '../../onboarding/codebase-analyzer.js'
import { createMemorySeeder, type MemorySeeder } from '../../onboarding/memory-seeder.js'
import {
  createSystemTeacher,
  type SystemTeacher,
} from '../../onboarding/system-teacher.js'
import { createMemoryService } from '../../memory/service.js'
import { createMondayClient } from '../../backlog/monday-client.js'
import { createGithubClient } from '../../github/client.js'
import { createProjectsService } from '../../projects/service.js'
import type { ProjectsService } from '../../projects/service.js'
import type { Actor } from '@orbital/types'
import { OrbitalError } from '@orbital/types'
import { PROJECTS_ERROR_CODES } from '../../projects/types.js'
import { logger } from '../../config/logger.js'
import { onboardingSessions } from '../../db/schema/onboarding.js'
import { eq } from 'drizzle-orm'

// ---------------------------------------------------------------------------
// Keychain account names
// ---------------------------------------------------------------------------

export const KEYCHAIN_ACCOUNT_ANTHROPIC = 'anthropic.api_key'
export const KEYCHAIN_ACCOUNT_MONDAY = 'monday.api_token'
export const KEYCHAIN_ACCOUNT_MONDAY_BOARD = 'monday.board_id'
/** Mirror of github/client.ts KEYCHAIN_ACCOUNT_GITHUB_TOKEN. */
export const KEYCHAIN_ACCOUNT_GITHUB = 'github.api_token'
/** Sidecar account so status query can echo the validated login back to the UI
 *  without re-calling GET /user on every status poll. */
export const KEYCHAIN_ACCOUNT_GITHUB_LOGIN = 'github.login'

// ---------------------------------------------------------------------------
// Lazy singletons
// ---------------------------------------------------------------------------

let _eventStore: ReturnType<typeof createEventStore> | null = null

// Round 9 lazy singletons
let _flowService: OnboardingFlowService | null = null
let _mondayProvisioner: MondayProvisioner | null = null
let _githubProvisioner: DefaultGithubProvisioner | null = null
let _codebaseAnalyzer: CodebaseAnalyzer | null = null
let _memorySeeder: MemorySeeder | null = null
let _systemTeacher: SystemTeacher | null = null
let _projectsService: ProjectsService | null = null

function getEventStore(): ReturnType<typeof createEventStore> {
  if (_eventStore === null) _eventStore = createEventStore(db, sqlPool)
  return _eventStore
}

function getFlowService(): OnboardingFlowService {
  if (_flowService === null) _flowService = createOnboardingFlowService(db, getEventStore())
  return _flowService
}

function getMondayProvisioner(): MondayProvisioner {
  if (_mondayProvisioner === null) {
    const client = createMondayClient()
    _mondayProvisioner = createMondayProvisioner(db, getEventStore(), client)
  }
  return _mondayProvisioner
}

function getGithubProvisioner(): DefaultGithubProvisioner {
  if (_githubProvisioner === null) {
    const client = createGithubClient()
    const raw: LowLevelGithubRequest = {
      request: <T>(
        method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
        path: string,
        body?: unknown,
        options?: { allow404?: boolean },
      ) => client.rawRequest<T>(method, path, body, options),
    }
    _githubProvisioner = createGithubProvisioner(db, getEventStore(), client, raw)
  }
  return _githubProvisioner
}

function getCodebaseAnalyzer(): CodebaseAnalyzer {
  if (_codebaseAnalyzer === null) {
    const client = createGithubClient()
    const raw: LowLevelGithubRequest = {
      request: <T>(
        method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
        path: string,
        body?: unknown,
        options?: { allow404?: boolean },
      ) => client.rawRequest<T>(method, path, body, options),
    }
    // LLM driver is null by default; the LLM-assisted pass falls back to
    // static-only when the driver is unavailable. Wiring an LLM driver here
    // would force a circular import with personas/anthropic-driver — instead
    // the LLM driver is registered post-boot via setCodebaseAnalyzerLLM().
    _codebaseAnalyzer = createCodebaseAnalyzer(getEventStore(), client, raw, null)
  }
  return _codebaseAnalyzer
}

function getMemorySeeder(): MemorySeeder {
  if (_memorySeeder === null) {
    const memory = createMemoryService(db, getEventStore())
    _memorySeeder = createMemorySeeder(memory)
  }
  return _memorySeeder
}

function getSystemTeacher(): SystemTeacher {
  if (_systemTeacher === null) {
    let provisioner: DefaultGithubProvisioner | null = null
    try {
      provisioner = getGithubProvisioner()
    } catch {
      // No GitHub token available — teacher still writes the local skill bundle.
    }
    _systemTeacher = createSystemTeacher(getEventStore(), provisioner)
  }
  return _systemTeacher
}

/**
 * Lazy projects-service singleton mirroring the construction in
 * trpc/routers/index.ts (`projectsRouter`). Used by `completeSession` to
 * materialise a real `projects` row from the wizard's collected basics so the
 * UI's projects list is non-empty after onboarding.
 */
function getProjectsService(): ProjectsService {
  if (_projectsService === null) {
    const monday = createMondayClient()
    const github = createGithubClient()
    _projectsService = createProjectsService(db, getEventStore(), {
      mondayClient: monday,
      githubClient: github,
    })
  }
  return _projectsService
}

/**
 * Test/integration helper — reset the lazy singletons so a re-import of the
 * router picks up env overrides. Mirrors the pattern in install-state tests.
 */
export function resetOnboardingRouterSingletons(): void {
  _eventStore = null
  _flowService = null
  _mondayProvisioner = null
  _githubProvisioner = null
  _codebaseAnalyzer = null
  _memorySeeder = null
  _systemTeacher = null
  _projectsService = null
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
          const [anthropic, monday, github, githubLogin] = await Promise.all([
            keychain.getPassword(KEYCHAIN_ACCOUNT_ANTHROPIC),
            keychain.getPassword(KEYCHAIN_ACCOUNT_MONDAY),
            keychain.getPassword(KEYCHAIN_ACCOUNT_GITHUB).catch(() => null),
            keychain.getPassword(KEYCHAIN_ACCOUNT_GITHUB_LOGIN).catch(() => null),
          ])
          // env fallback: github/client.ts also accepts process.env.GITHUB_API_TOKEN
          const envGithub =
            (typeof process !== 'undefined' && process.env['GITHUB_API_TOKEN']) || null
          const hasGithub =
            (github !== null && github.length > 0) ||
            (envGithub !== null && envGithub.length > 0)
          return {
            setupCompletedAt: state.setupCompletedAt,
            mode: state.mode,
            hasAnthropicToken: anthropic !== null && anthropic.length > 0,
            hasMondayToken: monday !== null && monday.length > 0,
            hasGithubToken: hasGithub,
            githubLogin: githubLogin && githubLogin.length > 0 ? githubLogin : null,
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

      github: publicProcedure
        .input(connectGithubInputSchema)
        .output(connectGithubOutputSchema)
        .mutation(async ({ input }) => {
          const validator = getGithubValidator()
          const result = await validator.validate(input.apiToken)
          if (!result.ok) return { ok: false, message: result.message }
          try {
            const keychain = await getKeychain()
            await keychain.setPassword(KEYCHAIN_ACCOUNT_GITHUB, input.apiToken)
            if (result.login) {
              await keychain.setPassword(KEYCHAIN_ACCOUNT_GITHUB_LOGIN, result.login)
            }
            const state = await readInstallState()
            await getEventStore().append({
              aggregate_id: state.installId,
              aggregate_type: 'install',
              event_type: 'GithubTokenStored',
              payload: { ok: true, login: result.login ?? null },
              actor: SYSTEM_ACTOR,
              trace_id: `onboarding-github-${state.installId}`,
              occurred_at: new Date().toISOString(),
              schema_version: 1,
            })
            // Reset the lazy github singletons so the next request picks up
            // the fresh token from the keychain (the client memoises its
            // resolvedToken on first use).
            _githubProvisioner = null
            _codebaseAnalyzer = null
            return result.login
              ? { ok: true, login: result.login }
              : { ok: true }
          } catch (err) {
            logger.warn({ err }, 'onboarding.connect.github: keychain write failed')
            return { ok: false, message: 'Validated, but failed to store token in keychain.' }
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
    // listGithubRepos — picker source for the existing-repo flow
    // [Engineer-Principal · Opus · run-orbital-onboarding-rework]
    // -----------------------------------------------------------------------
    listGithubRepos: publicProcedure
      .input(listGithubReposInputSchema)
      .output(listGithubReposOutputSchema)
      .query(async ({ input }) => {
        try {
          const client = createGithubClient()
          const affiliation = input?.affiliation ?? 'owner,collaborator,organization_member'
          const path = `/user/repos?per_page=100&sort=updated&affiliation=${encodeURIComponent(affiliation)}`
          const repos = await client.rawRequest<
            Array<{
              owner: { login: string }
              name: string
              full_name: string
              private: boolean
              default_branch: string
              pushed_at: string | null
            }>
          >('GET', path)
          if (!repos) {
            return { repos: [], truncated: false }
          }
          const projected = repos.map((r) => ({
            owner: r.owner.login,
            name: r.name,
            fullName: r.full_name,
            isPrivate: r.private,
            defaultBranch: r.default_branch,
            pushedAt: r.pushed_at,
          }))
          return { repos: projected, truncated: projected.length >= 100 }
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'onboarding.listGithubRepos failed',
          )
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message:
              err instanceof Error
                ? err.message
                : 'Could not list GitHub repos — connect GitHub first.',
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

    // -----------------------------------------------------------------------
    // Round 9 — Onboarding UX Overhaul procedures
    // [Engineer-Principal · Opus · run-round9-onboarding-overhaul]
    // -----------------------------------------------------------------------

    startSession: publicProcedure
      .input(startSessionInputSchema)
      .output(startSessionOutputSchema)
      .mutation(async ({ input }) => {
        try {
          const state = await readInstallState()
          const row = await getFlowService().start({
            installId: state.installId,
            flow: input.flow,
          })
          return rowToSessionDto(row)
        } catch (err) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err instanceof Error ? err.message : 'Could not start session',
            cause: err,
          })
        }
      }),

    resume: publicProcedure
      .output(resumeOutputSchema)
      .query(async () => {
        try {
          const state = await readInstallState()
          const row = await getFlowService().resume(state.installId)
          return { session: row ? rowToSessionDto(row) : null }
        } catch (err) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Could not resume session',
            cause: err,
          })
        }
      }),

    updateSession: publicProcedure
      .input(updateSessionInputSchema)
      .output(updateSessionOutputSchema)
      .mutation(async ({ input }) => {
        try {
          const row = await getFlowService().update({
            sessionId: input.sessionId,
            ...(input.step !== undefined ? { step: input.step } : {}),
            ...(input.patch !== undefined ? { patch: input.patch } : {}),
          })
          return rowToSessionDto(row)
        } catch (err) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err instanceof Error ? err.message : 'Could not update session',
            cause: err,
          })
        }
      }),

    abandonSession: publicProcedure
      .input(abandonSessionInputSchema)
      .output(abandonSessionOutputSchema)
      .mutation(async ({ input }) => {
        try {
          const row = await getFlowService().abandon(input.sessionId, input.reason)
          return rowToSessionDto(row)
        } catch (err) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err instanceof Error ? err.message : 'Could not abandon session',
            cause: err,
          })
        }
      }),

    completeSession: publicProcedure
      .input(completeFlowInputSchema)
      .output(completeFlowOutputSchema)
      .mutation(async ({ input }) => {
        try {
          // Resolve the canonical projectId. Precedence:
          //   1. Caller-supplied input.projectId (existing-repo / join flow)
          //   2. Existing session.projectId (already materialised by an earlier call)
          //   3. Materialise from session.stateJson.basics.{name,slug} (new_project)
          //
          // This is the bridge that turns the wizard's collected state into a
          // real `projects` row so the post-onboarding UI is non-empty. Done
          // here (not in flows.ts) to keep persistence concerns in the router
          // and the flow service focused on session state machine semantics.
          let canonicalProjectId: string | null = input.projectId ?? null
          if (canonicalProjectId === null) {
            const sessionRows = await db
              .select()
              .from(onboardingSessions)
              .where(eq(onboardingSessions.sessionId, input.sessionId))
              .limit(1)
            const existingProjectId = sessionRows[0]?.projectId ?? null
            if (existingProjectId) {
              canonicalProjectId = existingProjectId
            } else {
              const state = (sessionRows[0]?.stateJson ?? {}) as Record<string, unknown>
              const basics = (state['basics'] ?? {}) as Record<string, unknown>
              const tooling = (state['tooling'] ?? {}) as Record<string, unknown>
              const name = typeof basics['name'] === 'string' ? (basics['name'] as string) : null
              const rawSlug =
                typeof basics['slug'] === 'string' ? (basics['slug'] as string) : null
              if (name && rawSlug) {
                const slug = rawSlug
                  .toLowerCase()
                  .replace(/[^a-z0-9-]+/g, '-')
                  .replace(/^-+|-+$/g, '')
                const description =
                  typeof basics['description'] === 'string'
                    ? (basics['description'] as string)
                    : undefined
                const scmProvider =
                  typeof tooling['scmProvider'] === 'string'
                    ? (tooling['scmProvider'] as 'internal' | 'codecommit' | 'github')
                    : 'internal'
                const ticketProvider =
                  typeof tooling['ticketProvider'] === 'string'
                    ? (tooling['ticketProvider'] as 'internal' | 'monday')
                    : 'internal'
                try {
                  const created = await getProjectsService().create({
                    name,
                    slug,
                    ...(description !== undefined ? { description } : {}),
                    scmProvider,
                    ticketProvider,
                  })
                  canonicalProjectId = created.projectId
                } catch (createErr) {
                  if (
                    createErr instanceof OrbitalError &&
                    createErr.code === PROJECTS_ERROR_CODES.CONFLICT_SLUG
                  ) {
                    // Idempotent: a prior completeSession call already created
                    // this project. Look it up and reuse the id.
                    try {
                      const installState = await readInstallState()
                      const existing = await getProjectsService().getBySlug(
                        slug,
                        installState.installId,
                      )
                      canonicalProjectId = existing?.projectId ?? null
                    } catch (lookupErr) {
                      logger.warn(
                        { err: lookupErr instanceof Error ? lookupErr.message : String(lookupErr) },
                        'completeSession: getBySlug after CONFLICT_SLUG failed',
                      )
                    }
                  } else {
                    logger.warn(
                      { err: createErr instanceof Error ? createErr.message : String(createErr) },
                      'completeSession: project materialise failed (non-fatal)',
                    )
                  }
                }
              }
            }
          }

          const row = await getFlowService().complete(input.sessionId, canonicalProjectId)
          // B2: also mark install-level setup complete server-side so the
          // SetupGate stops bouncing every protected route to /welcome.
          // Without this, the user can finish the wizard and still be locked.
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
                source: 'completeSession',
              },
              actor: SYSTEM_ACTOR,
              trace_id: `onboarding-complete-${state.installId}`,
              occurred_at: state.setupCompletedAt ?? new Date().toISOString(),
              schema_version: 1,
            })
          } catch (markErr) {
            logger.warn(
              { err: markErr instanceof Error ? markErr.message : String(markErr) },
              'completeSession: markSetupCompleted failed (non-fatal)',
            )
          }
          return rowToSessionDto(row)
        } catch (err) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err instanceof Error ? err.message : 'Could not complete session',
            cause: err,
          })
        }
      }),

    createMondayBoard: publicProcedure
      .input(createMondayBoardInputSchema)
      .output(createMondayBoardOutputSchema)
      .mutation(async ({ input }) => {
        try {
          const result = await getMondayProvisioner().provision({
            sessionId: input.sessionId,
            projectId: input.projectId,
            projectName: input.projectName,
            workspaceId: input.workspaceId ?? null,
            isPrivate: input.isPrivate,
          })
          return result
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'onboarding.createMondayBoard failed',
          )
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err instanceof Error ? err.message : 'Monday board provisioning failed',
            cause: err,
          })
        }
      }),

    createGitRepo: publicProcedure
      .input(createGitRepoInputSchema)
      .output(createGitRepoOutputSchema)
      .mutation(async ({ input }) => {
        try {
          const result = await getGithubProvisioner().provision({
            sessionId: input.sessionId,
            projectId: input.projectId,
            name: input.name,
            org: input.org ?? null,
            description: input.description,
            isPrivate: input.isPrivate,
            stack: input.stack,
            license: input.license,
            webhookUrl: input.webhookUrl ?? null,
            webhookSecret: input.webhookSecret ?? null,
          })
          return result
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'onboarding.createGitRepo failed',
          )
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err instanceof Error ? err.message : 'GitHub repo provisioning failed',
            cause: err,
          })
        }
      }),

    estimateAnalyzeCodebase: publicProcedure
      .input(estimateAnalyzeCodebaseInputSchema)
      .output(estimateAnalyzeCodebaseOutputSchema)
      .query(async ({ input }) => {
        try {
          return await getCodebaseAnalyzer().estimate(input)
        } catch (err) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: 'Could not estimate analysis cost',
            cause: err,
          })
        }
      }),

    analyzeCodebase: publicProcedure
      .input(analyzeCodebaseInputSchema)
      .output(analyzeCodebaseOutputSchema)
      .mutation(async ({ input }) => {
        try {
          const report = await getCodebaseAnalyzer().analyze({
            sessionId: input.sessionId,
            projectId: input.projectId,
            owner: input.owner,
            repo: input.repo,
            useLLM: input.useLLM ?? false,
          })
          return report
        } catch (err) {
          logger.warn(
            { err: err instanceof Error ? err.message : String(err) },
            'onboarding.analyzeCodebase failed',
          )
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err instanceof Error ? err.message : 'Codebase analysis failed',
            cause: err,
          })
        }
      }),

    seedMemoryFromAnalysis: publicProcedure
      .input(seedMemoryFromAnalysisInputSchema)
      .output(seedMemoryOutputSchema)
      .mutation(async ({ input }) => {
        try {
          const result = await getMemorySeeder().seedFromAnalysis(
            {
              ...input.report,
              // The schema gives `inferredMemoryEntries` with `source.kind` typed, but the
              // analyzer's report type has it optional. Pass through as-is.
              inferredMemoryEntries: input.report.inferredMemoryEntries.map((e) => ({
                ...e,
                source: e.source as
                  | { kind: 'adr' | 'readme' | 'pr' | 'file'; ref: string }
                  | undefined,
              })),
            },
            input.projectId,
          )
          return result
        } catch (err) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err instanceof Error ? err.message : 'Memory seed failed',
            cause: err,
          })
        }
      }),

    seedMemoryFromVision: publicProcedure
      .input(seedMemoryFromVisionInputSchema)
      .output(seedMemoryOutputSchema)
      .mutation(async ({ input }) => {
        try {
          return await getMemorySeeder().seedFromVision({
            projectId: input.projectId,
            intent: input.intent,
            stack: input.stack,
            conventions: input.conventions,
            glossary: input.glossary,
          })
        } catch (err) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err instanceof Error ? err.message : 'Memory seed failed',
            cause: err,
          })
        }
      }),

    configureSystem: publicProcedure
      .input(configureSystemInputSchema)
      .output(configureSystemOutputSchema)
      .mutation(async ({ input }) => {
        try {
          const result = await getSystemTeacher().teach({
            sessionId: input.sessionId,
            projectId: input.projectId,
            projectName: input.projectName,
            ...(input.github ? { github: input.github } : {}),
            ...(input.vision ? { vision: input.vision } : {}),
            ...(input.analysis ? { analysis: input.analysis } : {}),
            ...(input.mondayBoardId !== undefined && input.mondayBoardId !== null
              ? { mondayBoardId: input.mondayBoardId }
              : {}),
            memoryEntryIds: input.memoryEntryIds,
            ...(input.skills ? { skills: input.skills } : {}),
          })
          return result
        } catch (err) {
          throw new TRPCError({
            code: 'INTERNAL_SERVER_ERROR',
            message: err instanceof Error ? err.message : 'System teach failed',
            cause: err,
          })
        }
      }),
  })
}

/**
 * Convert a row from `onboarding_sessions` to the DTO shape served to the UI.
 * Dates → ISO strings; nullable fields preserved.
 */
function rowToSessionDto(row: {
  sessionId: string
  installId: string
  flow: string
  currentStep: string
  status: string
  stateJson: unknown
  projectId: string | null
  startedAt: Date
  completedAt: Date | null
  abandonedAt: Date | null
}): {
  sessionId: string
  installId: string
  flow: 'new_project' | 'existing_repo' | 'join_hub'
  currentStep: string
  status: 'active' | 'completed' | 'abandoned'
  stateJson: Record<string, unknown>
  projectId: string | null
  startedAt: string
  completedAt: string | null
  abandonedAt: string | null
} {
  return {
    sessionId: row.sessionId,
    installId: row.installId,
    flow: row.flow as 'new_project' | 'existing_repo' | 'join_hub',
    currentStep: row.currentStep,
    status: row.status as 'active' | 'completed' | 'abandoned',
    stateJson: (row.stateJson as Record<string, unknown>) ?? {},
    projectId: row.projectId,
    startedAt: row.startedAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
    abandonedAt: row.abandonedAt ? row.abandonedAt.toISOString() : null,
  }
}

export type OnboardingRouter = ReturnType<typeof createOnboardingRouter>

// Lazy singleton — same pattern as the other "factory" routers.
let _router: OnboardingRouter | null = null
export function onboardingRouter(): OnboardingRouter {
  if (_router === null) _router = createOnboardingRouter()
  return _router
}
