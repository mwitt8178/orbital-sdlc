/**
 * @orbital/api-lambda — Lambda entry.
 *
 * Wires API Gateway HTTP API v2 events to the narrow `lambdaAppRouter`.
 * Cold-import side-effect-free — the router constructs lazily on first
 * request via `getLambdaAppRouter()`.
 *
 * Auth model:
 *   - JWT-protected route (`/trpc/{proxy+}`): API GW Cognito authorizer
 *     pre-verifies the token; we read claims from
 *     `event.requestContext.authorizer.jwt.claims` and trust them.
 *   - Public route (`/public/{proxy+}`): no API GW authorizer; ctx has
 *     no userId/tenantId. Public procedures self-gate by checking ctx.
 *   - Install route (`/install/{proxy+}`): handled by a separate Lambda
 *     (the install-lambda) — not this handler.
 */

import { awsLambdaRequestHandler } from '@trpc/server/adapters/aws-lambda'
import type { APIGatewayProxyEventV2WithRequestContext } from 'aws-lambda'

import { getLambdaAppRouter } from './router.js'
import { initOnce } from './init.js'

interface AuthClaims {
  tenantId: string | undefined
  userId: string | undefined
  email: string | undefined
  role: string | undefined
}

function extractAuth(event: APIGatewayProxyEventV2WithRequestContext<unknown>): AuthClaims {
  const authorizer = (
    event.requestContext as {
      authorizer?: {
        jwt?: { claims?: Record<string, string | undefined> }
      }
    }
  ).authorizer

  const claims = authorizer?.jwt?.claims
  if (!claims) {
    return { tenantId: undefined, userId: undefined, email: undefined, role: undefined }
  }
  const tenantId = claims['custom:tenant_id'] ?? claims['tenant_id']
  return {
    tenantId,
    userId: claims['sub'],
    email: claims['email'],
    role: claims['custom:role'],
  }
}

let _wrapped: ReturnType<typeof awsLambdaRequestHandler> | null = null

async function getWrappedHandler(): Promise<ReturnType<typeof awsLambdaRequestHandler>> {
  if (_wrapped) return _wrapped
  // Hydrate db + secrets BEFORE constructing the router so all sub-router
  // factories that synchronously read the db Proxy work correctly.
  const [router, { db, secrets }] = await Promise.all([
    getLambdaAppRouter(),
    initOnce(),
  ])
  _wrapped = awsLambdaRequestHandler({
    router,
    createContext: ({ event }) => {
      const auth = extractAuth(event as APIGatewayProxyEventV2WithRequestContext<unknown>)
      return {
        ...auth,
        db,
        secrets,
        req: {
          headers: ((event as { headers?: Record<string, string> }).headers ?? {}) as Record<
            string,
            string | undefined
          >,
        },
      }
    },
  })
  return _wrapped
}

// API Gateway calls this entry. Lambda runtime accepts a function returning
// either Promise<APIGatewayProxyResult> or Promise<APIGatewayProxyResultV2>.
// We delegate to the awsLambdaRequestHandler which produces v2-shaped output.
export const handler = async (
  event: unknown,
  context: unknown,
  callback: unknown,
): Promise<unknown> => {
  const wrapped = await getWrappedHandler()
  // The tRPC adapter accepts (event, context, callback) — pass through.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (wrapped as any)(event, context, callback)
}
