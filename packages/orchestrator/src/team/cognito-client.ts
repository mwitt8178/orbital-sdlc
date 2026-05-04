/**
 * cognito-client.ts — Thin wrapper around Cognito Idp Admin operations
 * used by the team service.
 *
 * [Engineer-Principal · Opus · run-feat-settings-team]
 *
 * SAFETY: gated by ORBITAL_TEAM_COGNITO_ENABLED. When disabled the wrapper
 * returns { skipped: true, reason } so the team service can still complete
 * its DB writes and surface a "pending IAM" status in the UI. This avoids
 * a runtime IAM denial before the api-lambda role is updated by the human-
 * approved CDK follow-up PR (per Engineer-Principal hard rule #1: no solo
 * decisions on stateful Cognito user pool changes).
 *
 * USER POOL: us-east-1_R89dMIxXb (live env per task brief).
 */

import { logger } from '../config/logger.js'

/**
 * @aws-sdk/client-cognito-identity-provider is loaded dynamically so the
 * module remains optional at install time. The api-lambda bundles it; local
 * dev w/o the dep installed simply runs in disabled mode.
 */
type CognitoClient = {
  send: (cmd: unknown) => Promise<unknown>
}

let _client: CognitoClient | null = null
let _ctorCache: {
  Client: new (cfg: { region: string }) => CognitoClient
  AdminCreateUser: new (input: unknown) => unknown
  AdminDisableUser: new (input: unknown) => unknown
  AdminEnableUser: new (input: unknown) => unknown
  AdminDeleteUser: new (input: unknown) => unknown
  AdminGetUser: new (input: unknown) => unknown
} | null = null

async function loadSdk() {
  if (_ctorCache) return _ctorCache
  try {
    const mod = (await import(
      /* @vite-ignore */ '@aws-sdk/client-cognito-identity-provider'
    )) as unknown as Record<string, unknown>
    _ctorCache = {
      Client: mod.CognitoIdentityProviderClient as never,
      AdminCreateUser: mod.AdminCreateUserCommand as never,
      AdminDisableUser: mod.AdminDisableUserCommand as never,
      AdminEnableUser: mod.AdminEnableUserCommand as never,
      AdminDeleteUser: mod.AdminDeleteUserCommand as never,
      AdminGetUser: mod.AdminGetUserCommand as never,
    }
    return _ctorCache
  } catch (err) {
    logger.warn(
      { err: (err as Error).message },
      'team.cognito: SDK package not installed; running in disabled mode',
    )
    return null
  }
}

function getClient(sdk: NonNullable<typeof _ctorCache>): CognitoClient {
  if (!_client) {
    const region = process.env.AWS_REGION ?? 'us-east-1'
    _client = new sdk.Client({ region })
  }
  return _client
}

export interface CognitoEnv {
  enabled: boolean
  userPoolId: string | null
}

export function readCognitoEnv(): CognitoEnv {
  const enabled =
    process.env.ORBITAL_TEAM_COGNITO_ENABLED === 'true' ||
    process.env.ORBITAL_TEAM_COGNITO_ENABLED === '1'
  const userPoolId = process.env.ORBITAL_COGNITO_USER_POOL_ID ?? null
  return { enabled, userPoolId }
}

export interface CognitoSkip {
  skipped: true
  reason: string
}

export interface CognitoOk {
  skipped: false
  cognitoSub: string | null
}

export type CognitoResult = CognitoSkip | CognitoOk

function disabled(reason: string): CognitoSkip {
  return { skipped: true, reason }
}

export async function adminCreateUser(opts: {
  email: string
  resend?: boolean
}): Promise<CognitoResult> {
  const env = readCognitoEnv()
  if (!env.enabled) return disabled('ORBITAL_TEAM_COGNITO_ENABLED is not set')
  if (!env.userPoolId) return disabled('ORBITAL_COGNITO_USER_POOL_ID is not set')

  const sdk = await loadSdk()
  if (!sdk) return disabled('@aws-sdk/client-cognito-identity-provider not installed')

  const client = getClient(sdk)
  try {
    const cmd = new sdk.AdminCreateUser({
      UserPoolId: env.userPoolId,
      Username: opts.email,
      DesiredDeliveryMediums: ['EMAIL'],
      ...(opts.resend ? { MessageAction: 'RESEND' } : {}),
      UserAttributes: [
        { Name: 'email', Value: opts.email },
        { Name: 'email_verified', Value: 'false' },
      ],
    })
    const out = (await client.send(cmd)) as { User?: { Attributes?: Array<{ Name: string; Value: string }> } }
    const subAttr = out.User?.Attributes?.find((a) => a.Name === 'sub')
    return { skipped: false, cognitoSub: subAttr?.Value ?? null }
  } catch (err) {
    logger.error(
      { err: (err as Error).message, email: opts.email },
      'team.cognito: AdminCreateUser failed',
    )
    throw err
  }
}

export async function adminDisableUser(email: string): Promise<CognitoResult> {
  const env = readCognitoEnv()
  if (!env.enabled) return disabled('ORBITAL_TEAM_COGNITO_ENABLED is not set')
  if (!env.userPoolId) return disabled('ORBITAL_COGNITO_USER_POOL_ID is not set')
  const sdk = await loadSdk()
  if (!sdk) return disabled('cognito sdk not installed')
  const client = getClient(sdk)
  await client.send(new sdk.AdminDisableUser({ UserPoolId: env.userPoolId, Username: email }))
  return { skipped: false, cognitoSub: null }
}

export async function adminDeleteUser(email: string): Promise<CognitoResult> {
  const env = readCognitoEnv()
  if (!env.enabled) return disabled('ORBITAL_TEAM_COGNITO_ENABLED is not set')
  if (!env.userPoolId) return disabled('ORBITAL_COGNITO_USER_POOL_ID is not set')
  const sdk = await loadSdk()
  if (!sdk) return disabled('cognito sdk not installed')
  const client = getClient(sdk)
  try {
    await client.send(new sdk.AdminDeleteUser({ UserPoolId: env.userPoolId, Username: email }))
    return { skipped: false, cognitoSub: null }
  } catch (err) {
    // Treat user-not-found as already-deleted; idempotent by design.
    const name = (err as { name?: string }).name
    if (name === 'UserNotFoundException') return { skipped: false, cognitoSub: null }
    throw err
  }
}

export async function adminGetUser(email: string): Promise<CognitoResult & { exists?: boolean }> {
  const env = readCognitoEnv()
  if (!env.enabled) return { ...disabled('disabled'), exists: false }
  if (!env.userPoolId) return { ...disabled('no pool'), exists: false }
  const sdk = await loadSdk()
  if (!sdk) return { ...disabled('no sdk'), exists: false }
  const client = getClient(sdk)
  try {
    const out = (await client.send(
      new sdk.AdminGetUser({ UserPoolId: env.userPoolId, Username: email }),
    )) as { UserAttributes?: Array<{ Name: string; Value: string }> }
    const sub = out.UserAttributes?.find((a) => a.Name === 'sub')?.Value ?? null
    return { skipped: false, cognitoSub: sub, exists: true }
  } catch (err) {
    const name = (err as { name?: string }).name
    if (name === 'UserNotFoundException') return { skipped: false, cognitoSub: null, exists: false }
    throw err
  }
}
