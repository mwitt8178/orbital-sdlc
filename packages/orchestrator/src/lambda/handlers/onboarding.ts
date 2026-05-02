/**
 * lambda/handlers/onboarding.ts — Onboarding router Lambda handler.
 *
 * [Engineer-Sr · Sonnet · run-round8-03-lambda-apigw-http]
 *
 * Handles: first-run wizard backend (status, mode selection, API key wiring)
 * Authorizer: Cognito JWT (browser sessions)
 * Provisioned Concurrency: 0
 */

import { makeHandler } from '../lambda-trpc-adapter.js'
import { onboardingRouter as makeOnboardingRouter } from '../../trpc/routers/onboarding.js'

let _router: ReturnType<typeof makeOnboardingRouter> | null = null
function getRouter(): ReturnType<typeof makeOnboardingRouter> {
  if (_router === null) {
    _router = makeOnboardingRouter()
  }
  return _router
}

export const handler = makeHandler(() => getRouter())
