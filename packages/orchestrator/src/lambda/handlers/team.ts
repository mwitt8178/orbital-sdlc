/**
 * lambda/handlers/team.ts — Team router Lambda handler.
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 *
 * Handles: known_installs, team member listing, presence
 * Authorizer: Cognito JWT (browser sessions)
 * Provisioned Concurrency: 0
 */

import { makeHandler } from '../lambda-trpc-adapter.js'
import { teamRouter } from '../../trpc/routers/team.js'

export const handler = makeHandler(() => teamRouter)
