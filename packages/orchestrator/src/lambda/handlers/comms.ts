/**
 * lambda/handlers/comms.ts — Comms router Lambda handler.
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 *
 * Handles: channels, messages, ceremony triggers, blockers
 * Authorizer: Cognito JWT (browser sessions)
 * Provisioned Concurrency: 0
 */

import { makeHandler } from '../lambda-trpc-adapter.js'
import { channelsRouter } from '../../trpc/routers/channels.js'

export const handler = makeHandler(() => channelsRouter)
