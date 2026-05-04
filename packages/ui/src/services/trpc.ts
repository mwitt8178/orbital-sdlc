import { createTRPCReact } from '@trpc/react-query'
import { httpBatchLink } from '@trpc/client'
// Type-only import — fully erased by the bundler. The orchestrator package
// exports its router types via `exports["./trpc"].types` in package.json.
import type { AppRouter } from '@orbital/orchestrator/trpc'
import { getActiveProjectId } from '../store/active-project.js'
import { authHeaders, externalSignOut } from '../auth/AuthContext.js'

/**
 * IMPORTANT: this file runs in the browser bundle. Do NOT import runtime
 * symbols from `@trpc/server` here. The lint rule in eslint.config.js
 * forbids `initTRPC` for that reason.
 */
export type { AppRouter }

/**
 * trpcLocal — always points at the local orchestrator (/trpc).
 * Use for: cost, replay, workers (live stdout), orchestration controls.
 *
 * Round 7-02 — local endpoint for local-only routers.
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 */
export const trpcLocal = createTRPCReact<AppRouter>()

/**
 * trpcHub — points at ORBITAL_HUB_URL when configured, else falls back to
 * the local endpoint. Use for: tasks, memory, channels, defects, audit, PRs,
 * sprints, retros, projects.
 *
 * The local orchestrator transparently proxies hub-bound procedures to the hub
 * when ORBITAL_HUB_URL is set (Round 7-02 proxy layer). So the UI always talks
 * to the local orchestrator; the orchestrator decides whether to serve locally
 * or proxy to hub. Both `trpcLocal` and `trpcHub` therefore point at /trpc on
 * the local host — the split is conceptual, backed by server-side routing.
 *
 * Convention: routers exposed by both endpoints use the `trpcHub.` prefix in
 * UI code to make the intended data source clear in code review.
 *
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 */
export const trpcHub = createTRPCReact<AppRouter>()

/**
 * trpc — legacy default export; backwards-compatible alias for trpcLocal.
 * Existing code continues to work unchanged. New code should use trpcLocal
 * or trpcHub explicitly.
 */
export const trpc = trpcLocal

/**
 * x-orbital-project-id header injection.
 *
 * Per Round 4 Projects Feature spec, every tRPC request carries the active
 * project id (when one is selected) so server-side handlers can scope their
 * queries via projects/active-project-context.ts helpers.
 *
 * Read at request time (not stored once) so a project switch immediately
 * affects subsequent requests without re-instantiating the tRPC client.
 */
function activeProjectHeaders(): Record<string, string> {
  const id = getActiveProjectId()
  return id ? { 'x-orbital-project-id': id } : {}
}

/**
 * Resolve the tRPC URL for browser-side calls.
 * Order:
 *   1. VITE_TRPC_URL — explicit absolute URL set at build time
 *      (e.g. https://hhhfb8pid6.execute-api.us-east-1.amazonaws.com/trpc)
 *   2. fall back to relative /trpc (works when UI + API are same-origin,
 *      e.g. self-host or when CloudFront has /trpc/* origin behavior).
 */
function trpcUrl(): string {
  const env = (import.meta as ImportMeta & {
    env?: Record<string, string | undefined>
  }).env
  const fromEnv = env?.['VITE_TRPC_URL']
  if (fromEnv && fromEnv.length > 0) {
    return fromEnv.endsWith('/trpc') ? fromEnv : `${fromEnv.replace(/\/$/, '')}/trpc`
  }
  return '/trpc'
}

export function createTrpcClient() {
  return trpcLocal.createClient({
    links: [
      httpBatchLink({
        url: trpcUrl(),
        headers: () => ({ ...activeProjectHeaders(), ...authHeaders() }),
        async fetch(input, init) {
          const res = await fetch(input, { ...init, credentials: 'omit' })
          // 401 from API GW JWT authorizer means the token is invalid or
          // expired. Force a sign-out so RequireAuth bounces the user to
          // /login on the next render. Server is the source of truth.
          if (res.status === 401) {
            externalSignOut()
          }
          return res
        },
      }),
    ],
  })
}

/**
 * createTrpcHubClient — tRPC client for hub-bound procedures.
 *
 * Points at the local orchestrator's /trpc endpoint. The orchestrator
 * proxies hub-bound routers to the hub when ORBITAL_HUB_URL is set.
 *
 * [Engineer-Sr · Sonnet · run-round7-02-local-hub-split]
 */
export function createTrpcHubClient() {
  return trpcHub.createClient({
    links: [
      httpBatchLink({
        url: trpcUrl(),
        headers: () => ({ ...activeProjectHeaders(), ...authHeaders() }),
        async fetch(input, init) {
          const res = await fetch(input, { ...init, credentials: 'omit' })
          // 401 from API GW JWT authorizer means the token is invalid or
          // expired. Force a sign-out so RequireAuth bounces the user to
          // /login on the next render. Server is the source of truth.
          if (res.status === 401) {
            externalSignOut()
          }
          return res
        },
      }),
    ],
  })
}
