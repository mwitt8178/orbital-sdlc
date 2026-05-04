/**
 * Cognito SDK wiring — singleton CognitoUserPool + thin promise wrappers.
 *
 * The pool is configured at build time via Vite env vars. The values are
 * publicly safe (the user pool ID and the public app client ID are visible
 * in any signed-in session anyway).
 */

import {
  AuthenticationDetails,
  CognitoRefreshToken,
  CognitoUser,
  CognitoUserAttribute,
  CognitoUserPool,
  CognitoUserSession,
} from 'amazon-cognito-identity-js'

interface ViteEnv {
  VITE_COGNITO_USER_POOL_ID?: string
  VITE_COGNITO_USER_POOL_CLIENT_ID?: string
}

function readEnv(): { userPoolId: string; clientId: string } {
  const env = (import.meta as ImportMeta & { env?: ViteEnv }).env ?? {}
  const userPoolId = env.VITE_COGNITO_USER_POOL_ID
  const clientId = env.VITE_COGNITO_USER_POOL_CLIENT_ID
  if (!userPoolId || !clientId) {
    throw new Error(
      'Cognito is not configured: VITE_COGNITO_USER_POOL_ID and VITE_COGNITO_USER_POOL_CLIENT_ID must be set at build time.',
    )
  }
  return { userPoolId, clientId }
}

let _pool: CognitoUserPool | null = null
export function getUserPool(): CognitoUserPool {
  if (_pool) return _pool
  const { userPoolId, clientId } = readEnv()
  _pool = new CognitoUserPool({ UserPoolId: userPoolId, ClientId: clientId })
  return _pool
}

export function newCognitoUser(email: string): CognitoUser {
  return new CognitoUser({ Username: email, Pool: getUserPool() })
}

export interface SessionTokens {
  idToken: string
  accessToken: string
  refreshToken: string
  expiresAt: number
}

function tokensFromSession(session: CognitoUserSession): SessionTokens {
  const idToken = session.getIdToken()
  return {
    idToken: idToken.getJwtToken(),
    accessToken: session.getAccessToken().getJwtToken(),
    refreshToken: session.getRefreshToken().getToken(),
    // Cognito returns exp in seconds — convert to ms.
    expiresAt: idToken.getExpiration() * 1000,
  }
}

export async function signInWithPassword(
  email: string,
  password: string,
): Promise<{ tokens: SessionTokens; user: CognitoUser }> {
  const user = newCognitoUser(email)
  const details = new AuthenticationDetails({ Username: email, Password: password })
  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: (session) => resolve({ tokens: tokensFromSession(session), user }),
      onFailure: (err) => reject(err),
      // We don't enroll users into MFA / new password flows here. If those are
      // ever turned on, surface them as explicit error codes the UI can branch on.
      mfaRequired: () => reject(new Error('MFA_NOT_SUPPORTED')),
      newPasswordRequired: () => reject(new Error('NEW_PASSWORD_REQUIRED')),
    })
  })
}

export async function signUp(
  email: string,
  password: string,
  attributes: { name: string },
): Promise<void> {
  const pool = getUserPool()
  const attrs: CognitoUserAttribute[] = [
    new CognitoUserAttribute({ Name: 'email', Value: email }),
    new CognitoUserAttribute({ Name: 'name', Value: attributes.name }),
  ]
  return new Promise((resolve, reject) => {
    pool.signUp(email, password, attrs, [], (err) => {
      if (err) return reject(err)
      resolve()
    })
  })
}

export async function confirmSignUp(email: string, code: string): Promise<void> {
  const user = newCognitoUser(email)
  return new Promise((resolve, reject) => {
    user.confirmRegistration(code, true, (err) => {
      if (err) return reject(err)
      resolve()
    })
  })
}

export async function resendConfirmationCode(email: string): Promise<void> {
  const user = newCognitoUser(email)
  return new Promise((resolve, reject) => {
    user.resendConfirmationCode((err) => {
      if (err) return reject(err)
      resolve()
    })
  })
}

export async function forgotPassword(email: string): Promise<void> {
  const user = newCognitoUser(email)
  return new Promise((resolve, reject) => {
    user.forgotPassword({
      onSuccess: () => resolve(),
      onFailure: (err) => reject(err),
    })
  })
}

export async function confirmForgotPassword(
  email: string,
  code: string,
  newPassword: string,
): Promise<void> {
  const user = newCognitoUser(email)
  return new Promise((resolve, reject) => {
    user.confirmPassword(code, newPassword, {
      onSuccess: () => resolve(),
      onFailure: (err) => reject(err),
    })
  })
}

/**
 * Refresh tokens using a stored refresh token. Returns fresh SessionTokens.
 * The CognitoUser API requires constructing a session from raw tokens to
 * call refreshSession, so we go through the lower-level path.
 */
export async function refreshTokens(
  email: string,
  refreshToken: string,
): Promise<SessionTokens> {
  const user = newCognitoUser(email)
  const token = new CognitoRefreshToken({ RefreshToken: refreshToken })
  return new Promise((resolve, reject) => {
    user.refreshSession(token, (err, session: CognitoUserSession) => {
      if (err || !session) return reject(err ?? new Error('refresh failed'))
      resolve(tokensFromSession(session))
    })
  })
}

/**
 * Decode a JWT payload without verifying — server still verifies, this is
 * UI-only convenience for displaying email / sub etc. Never trust these
 * values for authorization decisions.
 */
export function decodeJwtPayload<T = Record<string, unknown>>(jwt: string): T | null {
  try {
    const parts = jwt.split('.')
    if (parts.length !== 3) return null
    const payload = parts[1]
    if (!payload) return null
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4)
    const json = atob(padded.replace(/-/g, '+').replace(/_/g, '/'))
    return JSON.parse(json) as T
  } catch {
    return null
  }
}

/**
 * Map raw Cognito errors to a small, UI-safe taxonomy. PreventUserExistenceErrors
 * is enabled on this pool, so wrong-email and wrong-password both come back as
 * NotAuthorizedException — we surface a single generic message for both.
 */
export function describeCognitoError(err: unknown): string {
  const e = err as { name?: string; code?: string; message?: string }
  const name = e?.name ?? e?.code ?? ''
  const message = e?.message ?? ''
  switch (name) {
    case 'NotAuthorizedException':
      return 'Incorrect email or password.'
    case 'UserNotConfirmedException':
      return 'Please verify your email before signing in.'
    case 'PasswordResetRequiredException':
      return 'You must reset your password before signing in.'
    case 'UsernameExistsException':
      return 'An account with that email already exists.'
    case 'CodeMismatchException':
      return 'That code is incorrect. Please try again.'
    case 'ExpiredCodeException':
      return 'That code has expired. Request a new one.'
    case 'LimitExceededException':
      return 'Too many attempts. Wait a few minutes and try again.'
    case 'InvalidPasswordException':
      return 'Password does not meet the policy. Use 12+ chars with upper, lower, digit, and symbol.'
    case 'InvalidParameterException':
      // Cognito uses this for malformed email + a few other things.
      return message || 'Invalid input.'
    default:
      return message || 'Something went wrong. Please try again.'
  }
}
