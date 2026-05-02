/**
 * lambda/handlers/providers.ts — Providers router Lambda handler.
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 *
 * Handles: model provider management, health checks, routing rules
 * Authorizer: Cognito JWT (browser sessions)
 * Provisioned Concurrency: 0
 */

import { makeHandler } from '../lambda-trpc-adapter.js'
import { providersRouter } from '../../trpc/routers/providers.js'

export const handler = makeHandler(() => providersRouter)
