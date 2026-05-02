/**
 * lambda/handlers/tasks.ts — Tasks router Lambda handler.
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 *
 * Handles: backlog, sprint, UAT, retro, orchestration (task lifecycle)
 * Authorizer: Cognito JWT (browser) or PKI envelope (install traffic at /install/)
 * Provisioned Concurrency: 2 (hot path — most agent interactions go through tasks)
 *
 * This handler maps to the 'tasks' logical group which covers the core
 * orchestration loop: task claiming, status updates, sprint management.
 */

import { makeHandler } from '../lambda-trpc-adapter.js'
import { orchestrationRouter } from '../../trpc/routers/orchestration.js'

export const handler = makeHandler(() => orchestrationRouter)
