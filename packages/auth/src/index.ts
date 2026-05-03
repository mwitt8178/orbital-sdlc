/**
 * @orbital/auth — JWT + PKI verifiers.
 *
 * Phase 3.3 of the migration plan: extracts JWT/PKI verification helpers
 * from the orchestrator package. Until the migration completes, this is a
 * shim that re-exports from the orchestrator's lambda/ws-auth and
 * lambda/handlers/install-authorizer modules.
 *
 * Phase 3.6 enforces this barrel as the only entry; legacy imports lint-fail.
 */

// Cognito JWT verifier (used by api-lambda + WS auth)
// Re-export shim — replaced with native implementation after Phase 3.6 file moves.
export {
  verifyCognitoJwt,
  type JwtClaims,
} from '../../orchestrator/src/lambda/ws-auth/cognito.js'

// PKI envelope verifier (used by install-lambda + hub middleware)
// verifyEnvelope lives in keys/envelope.ts — re-exported here under the
// preferred name `verifyInstallEnvelope` for clarity at the call site.
export { verifyEnvelope as verifyInstallEnvelope } from '../../orchestrator/src/keys/envelope.js'
export type { VerifyResult as InstallVerifyResult } from '../../orchestrator/src/keys/envelope.js'
