/**
 * lambda/handlers/prs.ts — PRs router Lambda handler.
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 *
 * Handles: PR linkage, check runs, CI bridge
 * Authorizer: Cognito JWT (browser sessions)
 * Provisioned Concurrency: 0
 */

import { makeHandler } from '../lambda-trpc-adapter.js'
import { prsRouter } from '../../trpc/routers/prs.js'

export const handler = makeHandler(() => prsRouter)
