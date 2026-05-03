/**
 * lambda/handlers/trpc-all.ts — Catch-all tRPC Lambda handler.
 *
 * [Engineer-Sr · Sonnet · run-round8-09-trpc-catchall]
 *
 * tRPC v10 emits dot-separated procedure paths in URLs:
 *     /trpc/onboarding.status
 *     /trpc/projects.list
 *     /trpc/cost.summary
 *
 * API Gateway HTTP API V2 routes use slash segments — `/trpc/<router>/{proxy+}`
 * cannot match `/trpc/<router>.<proc>`. Wiring a route per sub-router therefore
 * 404s every UI tRPC call.
 *
 * This handler is wired to a single catch-all `/trpc/{proxy+}` route and uses
 * the full root `appRouter` so any procedure path resolves through one Lambda.
 *
 * Authorizer: Cognito JWT (browser sessions).
 */

import { makeHandler } from '../lambda-trpc-adapter.js'
import { appRouter } from '../../trpc/routers/index.js'

export const handler = makeHandler(() => appRouter)
