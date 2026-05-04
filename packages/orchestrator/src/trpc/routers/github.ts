/**
 * trpc/routers/github.ts — GitHub App installation + repo binding procedures.
 *
 * [Engineer-Principal · Opus · run-orbital-github-integration]
 *
 * Procedures:
 *   github.recordInstallation  — exchange manifest code OR record an
 *                                installation_id from the post-install redirect
 *   github.listInstallations   — list installations bound to the current tenant
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
// fix/multi-project-isolation
import { projectProcedure } from '../middleware/project.js'
import { db } from '../../db/client.js'
import { githubInstallations, githubRepoBindings } from '@orbital/db'

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
        tenantId: ctx.tenantId!,
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
      .where(eq(githubInstallations.tenantId, ctx.tenantId!))
      .orderBy(desc(githubInstallations.installedAt))
    return rows
  }),

  /** Bind an Orbital project to a (installation_id, full_name) pair. */
  bindRepo: projectProcedure.input(bindRepoInput).mutation(async ({ ctx, input }) => {
    // fix/multi-project-isolation — input.projectId must match active project
    if (input.projectId !== ctx.projectId) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'projectId mismatch between input and active project header',
      })
    }
    const installationId = asNumber(input.installationId)
    const githubRepoId = asNumber(input.githubRepoId)
    const bindingId = uuidv7()
    await db.insert(githubRepoBindings).values({
      bindingId,
      tenantId: ctx.tenantId!,
      projectId: input.projectId,
      installationId,
      githubRepoId,
      fullName: input.repoFullName,
      defaultBranch: input.defaultBranch,
    })
    return { bindingId }
  }),

  /** List active bindings for a project. */
  listBindings: projectProcedure.input(listBindingsInput).query(async ({ ctx, input }) => {
    // fix/multi-project-isolation
    if (input.projectId !== ctx.projectId) {
      throw new TRPCError({
        code: 'BAD_REQUEST',
        message: 'projectId mismatch between input and active project header',
      })
    }
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
          eq(githubRepoBindings.tenantId, ctx.tenantId!),
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
