/**
 * lambda/handlers/cost.ts — Cost router Lambda handler.
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 *
 * Handles: cost summary, ledger, budget management (read-only hub-side)
 * Authorizer: Cognito JWT (browser sessions)
 * Provisioned Concurrency: 0
 */

import { makeHandler } from '../lambda-trpc-adapter.js'
import { costRouter } from '../../trpc/routers/cost.js'

export const handler = makeHandler(() => costRouter)
