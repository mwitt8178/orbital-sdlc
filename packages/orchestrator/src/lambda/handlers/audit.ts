/**
 * lambda/handlers/audit.ts — Audit router Lambda handler.
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 *
 * Handles: audit event queries, reconciliation, audit export
 * Authorizer: Cognito JWT (browser sessions and install traffic can both read audit)
 * Provisioned Concurrency: 0
 */

import { makeHandler } from '../lambda-trpc-adapter.js'
import { auditRouter } from '../../trpc/routers/audit.js'

export const handler = makeHandler(() => auditRouter)
