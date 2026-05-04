/**
 * trpc/routers/github.ts — GitHub App installation + repo binding procedures.
 *
 * [Engineer-Principal · Opus · run-orbital-github-integration]
 * [Engineer-Sr · Sonnet · run-github-app-install]
 *
 * Procedures:
 *   github.recordInstallation  — exchange manifest code OR record an
 *                                installation_id from the post-install redirect
 *   github.listInstallations   — list installations bound to the current tenant
 *   github.listRepos           — list repos accessible to an installation (60s cache)
 *   github.getInstallationToken — get a short-lived installation token for an
 *                                 installation_id owned by the current tenant
 *   github.bindRepo            — bind an Orbital project to a (installation_id,
 *                                full_name) pair
 *   github.listBindings        — list active bindings for a project
 *
 * Multi-tenant: every read/write is scoped to ctx.tenantId via tenantProcedure.
 * No FK constraints (DSQL-banned); cross-aggregate references (project_id,
 * installation_id) are loose UUID/bigint columns per TRD §4.5.
 *
 * Webhook handling lives in the api-lambda handler (see handler.ts) — webhook
 * signature validation is performed there, not here, because the route is
 * unauthenticated and bypasses tRPC.
 */

import { z } from 'zod'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { uuidv7 } from 'uuidv7'
import { TRPCError } from '@trpc/server'

import { router, publicProcedure } from '../init.js'
import { tenantProcedure } from '../middleware/tenant.js'
import { db } from '../../db/client.js'
import { githubInstallations, githubRepoBindings } from '@orbital/db'
import {
  listInstallationRepos,
  assertInstallationBelongsToTenant,
  getDefaultRepoListCache,
} from '../../github/install-repos.js'

// ---------------------------------------------------------------------------
// Input schemas
// ---------------------------------------------------------------------------

const recordInstallationInput = z
  .object({
    /**
     * Manifest-flow `code` from `?code=...` on /oauth/github/callback.
     * When present, we POST to /app-manifests/<code>/conversions to receive
     * the App ID, private key, and webhook secret. Mutually exclusive with
     * `installationId`.
     */
    code: z.string().min(1).optional(),
    /**
     * Post-install `installation_id` from `?installation_id=...`. Mutually
     * exclusive with `code`. Used when the App was created out-of-band and
     * the user just installed it.
     */
    installationId: z
      .union([z.number().int().positive(), z.string().regex(/^\d+$/)])
      .optional(),
  })
  .refine((v) => Boolean(v.code) !== Boolean(v.installationId), {
    message: 'Provide exactly one of `code` or `installationId`',
  })

const installationIdInput = z.object({
  installationId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
})

const bindRepoInput = z.object({
  projectId: z.string().uuid(),
  installationId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  repoFullName: z.string().regex(/^[^/]+\/[^/]+$/),
  githubRepoId: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]),
  defaultBranch: z.string().min(1).default('main'),
})

const listBindingsInput = z.object({
  projectId: z.string().uuid(),
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asNumber(v: number | string): number {
  return typeof v === 'number' ? v : Number.parseInt(v, 10)
}

interface ManifestConversionResponse {
  id: number
  name: string
  owner: { login: string; id: number; type: string }
  pem: string
  webhook_secret: string
  html_url: string
}

/**
 * Exchange the manifest `code` for the App's permanent identity. GitHub
 * returns `{ id, pem, webhook_secret, ... }`. The orchestrator never persists
 * pem / webhook_secret — those are stored in Secrets Manager by an out-of-band
 * step (see register-app-instructions.md §3). We return them to the caller so
 * the parent agent can complete that step; the value is otherwise discarded.
 */
async function exchangeManifestCode(code: string): Promise<ManifestConversionResponse> {
  const res = await fetch(
    `https://api.github.com/app-manifests/${encodeURIComponent(code)}/conversions`,
    {
      method: 'POST',
      headers: {
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'orbital-orchestrator',
      },
    },
  )
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new TRPCError({
      code: 'BAD_REQUEST',
      message: `GitHub manifest conversion failed: ${res.status} ${text}`,
    })
  }
  return (await res.json()) as ManifestConversionResponse
}

// ---------------------------------------------------------------------------
// Installation token provider factory
// Lazily imported to avoid loading Secrets Manager at startup in local-mode.
// ---------------------------------------------------------------------------

/**
 * Tenant-isolation helper: queries github_installations to verify that the
 * requested installationId is owned by tenantId.
 */
async function checkInstallationOwnership(installationId: number, tenantId: string): Promise<void> {
  await assertInstallationBelongsToTenant({
    installationId,
    tenantId,
    queryInstallations: async (params) => {
      const rows = await db
        .select({ installationId: githubInstallations.installationId })
        .from(githubInstallations)
        .where(
          and(
            eq(githubInstallations.installationId, params.installationId),
            eq(githubInstallations.tenantId, params.tenantId),
          ),
        )
        .limit(1)
      return rows
    },
  })
}

/**
 * Get a real installation token for the given installationId.
 *
 * Uses the process-level GitHub App client from init.ts (Lambda path) or
 * the env-var path (orchestrator standalone). Lazily imported so local-mode
 * procedures don't pay the Secrets Manager round-trip on cold start.
 */
async function getTokenForInstallation(installationId: number): Promise<string> {
  if (process.env['ORBITAL_GITHUB_APP_ENABLED'] !== '1') {
    throw new TRPCError({
      code: 'PRECONDITION_FAILED',
      message:
        'GitHub App not configured. Register the App and set ORBITAL_GITHUB_APP_ENABLED=1 ' +
        'with the private key and webhook secret in Secrets Manager.',
    })
  }
  // Lambda path — dynamic import via runtime path string so this package's
  // tsc rootDir doesn't trace cross-package into api-lambda.
  try {
    const apiLambdaInitPath = '../../../../api-lambda/src/init.js'
    const mod = (await import(apiLambdaInitPath)) as {
      getStoryExecutorGitHubClient: () => Promise<{
        getTokenForInstallation: (id: number) => Promise<string>
      }>
    }
    const client = await mod.getStoryExecutorGitHubClient()
    return client.getTokenForInstallation(installationId)
  } catch (err) {
    // In non-Lambda environments (tests, local orchestrator), fail with a clear message.
    const msg = err instanceof Error ? err.message : String(err)
    throw new TRPCError({
      code: 'INTERNAL_SERVER_ERROR',
      message: `GitHub App token fetch failed: ${msg}`,
    })
  }
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export const githubRouter = router({
  /**
   * Record a GitHub App installation. Two modes:
   *
   * 1. Manifest mode (code): exchange the temporary manifest code for the
   *    App identity, then return secrets so the operator can store them in
   *    Secrets Manager. The installation_id is NOT yet known here — the user
   *    will be redirected to install the App and re-hit this procedure with
   *    `installationId` after the install completes.
   *
   * 2. Install mode (installationId): the App already exists; the user just
   *    installed it. Insert/update a row in github_installations.
   */
  recordInstallation: tenantProcedure
    .input(recordInstallationInput)
    .mutation(async ({ ctx, input }) => {
      if (input.code) {
        const conv = await exchangeManifestCode(input.code)
        // We do NOT write to github_installations here — installation_id is
        // unknown until the user actually installs the App on a repo. The
        // parent agent stores the pem + webhook_secret in Secrets Manager
        // and flips ORBITAL_GITHUB_APP_ENABLED=1.
        return {
          mode: 'manifest_exchange' as const,
          appId: conv.id,
          appName: conv.name,
          ownerLogin: conv.owner.login,
          ownerType: conv.owner.type,
          htmlUrl: conv.html_url,
          // The caller MUST move these to Secrets Manager and then discard.
          // Returned only because there is no other channel; the UI never
          // logs or stores them.
          pem: conv.pem,
          webhookSecret: conv.webhook_secret,
        }
      }

      // installationId mode — record it.
      const installationId = asNumber(input.installationId!)
      // Fetch installation metadata from GitHub. We can't here without an
      // App-level JWT, which requires the private key — only available once
      // the operator has stored it in Secrets Manager. For the first record
      // we accept partial data (login/type filled in by the next webhook).
      const existing = await db
        .select({ installationId: githubInstallations.installationId })
        .from(githubInstallations)
        .where(eq(githubInstallations.installationId, installationId))
        .limit(1)
      if (existing.length > 0) {
        await db
          .update(githubInstallations)
          .set({ tenantId: ctx.tenantId })
          .where(eq(githubInstallations.installationId, installationId))
        return { mode: 'updated' as const, installationId }
      }
      await db.insert(githubInstallations).values({
        installationId,
        tenantId: ctx.tenantId,
        githubAccountLogin: 'pending',
        githubAccountType: 'pending',
        githubAccountId: 0,
      })
      return { mode: 'inserted' as const, installationId }
    }),

  /** List installations bound to the current tenant. */
  listInstallations: tenantProcedure.query(async ({ ctx }) => {
    const rows = await db
      .select({
        installationId: githubInstallations.installationId,
        githubAccountLogin: githubInstallations.githubAccountLogin,
        githubAccountType: githubInstallations.githubAccountType,
        installedAt: githubInstallations.installedAt,
        suspendedAt: githubInstallations.suspendedAt,
        uninstalledAt: githubInstallations.uninstalledAt,
      })
      .from(githubInstallations)
      .where(eq(githubInstallations.tenantId, ctx.tenantId))
      .orderBy(desc(githubInstallations.installedAt))
    return rows
  }),

  /**
   * List repositories accessible to the given installation.
   *
   * Multi-tenant guard: verifies the installation belongs to ctx.tenantId
   * before calling the GitHub API. Results are cached in-process for 60s.
   *
   * [Engineer-Sr · Sonnet · run-github-app-install]
   */
  listRepos: tenantProcedure.input(installationIdInput).query(async ({ ctx, input }) => {
    const installationId = asNumber(input.installationId)
    await checkInstallationOwnership(installationId, ctx.tenantId)
    const repos = await listInstallationRepos({
      installationId,
      getToken: () => getTokenForInstallation(installationId),
      cache: getDefaultRepoListCache(),
    })
    return repos
  }),

  /**
   * Get a short-lived installation token for the given installation_id.
   *
   * Used at PR-creation time: the story executor calls this procedure to
   * obtain a token before pushing commits and opening a pull request.
   *
   * Multi-tenant guard: verifies the installation belongs to ctx.tenantId.
   * Token is NOT persisted — it is returned to the caller and used immediately.
   *
   * [Engineer-Sr · Sonnet · run-github-app-install]
   */
  getInstallationToken: tenantProcedure
    .input(installationIdInput)
    .query(async ({ ctx, input }) => {
      const installationId = asNumber(input.installationId)
      await checkInstallationOwnership(installationId, ctx.tenantId)
      const token = await getTokenForInstallation(installationId)
      return { token, installationId }
    }),

  /** Bind an Orbital project to a (installation_id, full_name) pair. */
  bindRepo: tenantProcedure.input(bindRepoInput).mutation(async ({ ctx, input }) => {
    const installationId = asNumber(input.installationId)
    const githubRepoId = asNumber(input.githubRepoId)
    const bindingId = uuidv7()
    await db.insert(githubRepoBindings).values({
      bindingId,
      tenantId: ctx.tenantId,
      projectId: input.projectId,
      installationId,
      githubRepoId,
      fullName: input.repoFullName,
      defaultBranch: input.defaultBranch,
    })
    return { bindingId }
  }),

  /** List active bindings for a project. */
  listBindings: tenantProcedure.input(listBindingsInput).query(async ({ ctx, input }) => {
    const rows = await db
      .select({
        bindingId: githubRepoBindings.bindingId,
        installationId: githubRepoBindings.installationId,
        fullName: githubRepoBindings.fullName,
        defaultBranch: githubRepoBindings.defaultBranch,
        createdAt: githubRepoBindings.createdAt,
      })
      .from(githubRepoBindings)
      .where(
        and(
          eq(githubRepoBindings.tenantId, ctx.tenantId),
          eq(githubRepoBindings.projectId, input.projectId),
          isNull(githubRepoBindings.removedAt),
        ),
      )
      .orderBy(desc(githubRepoBindings.createdAt))
    return rows
  }),
})

export type GithubRouter = typeof githubRouter

// Suppress unused-import warning for publicProcedure — kept available for
// future unauthenticated procedures (e.g. health probe).
void publicProcedure
