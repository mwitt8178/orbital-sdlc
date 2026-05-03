/**
 * lambda/handlers/auth.ts — Auth router Lambda handler.
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 *
 * Handles: login callbacks, refresh, sign-out
 * Authorizer: Cognito JWT (browser sessions)
 * Provisioned Concurrency: 2 (hot path)
 *
 * The auth router wraps the admin router for the hub's auth procedures
 * (token validation, session management). In the AWS deployment the Cognito
 * hosted UI handles the OAuth flow; this handler serves post-auth hub operations.
 */

import { makeHandler } from '../lambda-trpc-adapter.js'
import { adminRouter as authRouter } from '../../trpc/routers/admin.js'

// Handler exported at module scope — cold start happens once per container
// authRouter is a factory function (() => AdminRouter); call it here so
// makeHandler receives () => AdminRouter, not () => (() => AdminRouter).
export const handler = makeHandler(() => authRouter())
