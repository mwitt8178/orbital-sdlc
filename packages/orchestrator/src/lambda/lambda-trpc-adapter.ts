/**
 * lambda/lambda-trpc-adapter.ts — Shared tRPC-over-Lambda adapter factory.
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 *
 * Wraps `@trpc/server/adapters/aws-lambda` to provide a consistent context
 * factory for all router group handlers. Each handler imports `makeHandler`
 * and passes its own tRPC router.
 *
 * Context strategy:
 *   - For Cognito-authed routes:  authorizer injects `sub` (userId), `email`
 *   - For install-authed routes:  install authorizer injects installId, tenantId, role
 *   - Both paths populate tenantId in the tRPC context for tenant isolation
 *
 * Multi-tenant isolation self-check:
 *   tenantId is ALWAYS sourced from the authorizer context (never from
 *   the request body). The authorizer is the trust boundary. Procedures
 *   that access tenant data use tenantId from ctx, not from tRPC input.
 *
 * The `event.requestContext.authorizer` shape differs by authorizer type:
 *   Cognito JWT:  event.requestContext.authorizer.jwt.claims
 *   Lambda:       event.requestContext.authorizer.lambda (our custom context)
 */

import type { APIGatewayProxyEventV2WithRequestContext } from 'aws-lambda'
import type { AnyRouter } from '@trpc/server'
import { awsLambdaRequestHandler } from '@trpc/server/adapters/aws-lambda'
import { initOnce } from './init.js'

/**
 * tRPC request context injected into every procedure.
 * Extends the existing ReqContext from trpc/init.ts with AWS-specific fields.
 */
export interface LambdaReqContext {
  /**
   * Resolved tenant ID — from JWT claim (Cognito) or Lambda authorizer context.
   * Always populated after auth; never undefined in an authenticated request.
   */
  readonly tenantId: string | undefined
  /**
   * Install ID — from PKI envelope authorizer context (install-to-hub traffic).
   * undefined for Cognito-authed browser sessions.
   */
  readonly installId: string | undefined
  /**
   * User ID (Cognito sub claim) — from JWT authorizer.
   * undefined for install-authed machine traffic.
   */
  readonly userId: string | undefined
  /**
   * User email — from Cognito JWT email claim.
   * undefined for install-authed machine traffic.
   */
  readonly email: string | undefined
  /**
   * Install role — from PKI envelope authorizer context.
   * e.g. 'owner' | 'member' | 'viewer'
   * undefined for Cognito-authed browser sessions.
   */
  readonly role: string | undefined
  /**
   * Raw DB client — provided by initOnce() on cold start.
   */
  readonly db: Awaited<ReturnType<typeof initOnce>>['db']
  /**
   * Secrets — provided by initOnce() on cold start.
   */
  readonly secrets: Awaited<ReturnType<typeof initOnce>>['secrets']
}

/**
 * Extract authorizer context from API Gateway v2 event.
 *
 * Handles both authorizer types:
 *  - JWT (Cognito): event.requestContext.authorizer.jwt.claims
 *  - Lambda (install): event.requestContext.authorizer.lambda
 */
function extractAuthContext(event: APIGatewayProxyEventV2WithRequestContext<unknown>): {
  tenantId: string | undefined
  installId: string | undefined
  userId: string | undefined
  email: string | undefined
  role: string | undefined
} {
  const authorizer = (
    event.requestContext as {
      authorizer?: {
        jwt?: { claims?: Record<string, string | undefined> }
        lambda?: Record<string, string | undefined>
      }
    }
  ).authorizer

  if (!authorizer) {
    return {
      tenantId: undefined,
      installId: undefined,
      userId: undefined,
      email: undefined,
      role: undefined,
    }
  }

  // Lambda authorizer (install-auth PKI envelope)
  if (authorizer.lambda) {
    const ctx = authorizer.lambda
    return {
      tenantId: ctx['tenantId'],
      installId: ctx['installId'],
      userId: undefined,
      email: undefined,
      role: ctx['role'],
    }
  }

  // Cognito JWT authorizer
  if (authorizer.jwt?.claims) {
    const claims = authorizer.jwt.claims
    // Cognito custom:tenant_id claim or fall back to sub-based tenant
    const tenantId = claims['custom:tenant_id'] ?? claims['tenant_id']
    return {
      tenantId,
      installId: undefined,
      userId: claims['sub'],
      email: claims['email'],
      role: claims['custom:role'],
    }
  }

  return {
    tenantId: undefined,
    installId: undefined,
    userId: undefined,
    email: undefined,
    role: undefined,
  }
}

/**
 * makeHandler — create a Lambda handler for a tRPC router.
 *
 * Usage in a handler file:
 *   import { makeHandler } from '../lambda-trpc-adapter.js'
 *   import { tasksRouter } from '../../trpc/routers/tasks.js'
 *   export const handler = makeHandler(tasksRouter)
 */
export function makeHandler<TRouter extends AnyRouter>(
  getRouter: () => TRouter,
): ReturnType<typeof awsLambdaRequestHandler> {
  return awsLambdaRequestHandler({
    router: getRouter(),
    createContext: async ({ event }) => {
      const { db, secrets } = await initOnce()
      const authCtx = extractAuthContext(
        event as APIGatewayProxyEventV2WithRequestContext<unknown>,
      )
      return {
        ...authCtx,
        db,
        secrets,
        // Backwards compat: expose req.headers shape for existing middleware
        req: {
          headers: (event as { headers?: Record<string, string> }).headers ?? {},
        },
      } satisfies LambdaReqContext & { req: { headers: Record<string, string | undefined> } }
    },
  })
}
