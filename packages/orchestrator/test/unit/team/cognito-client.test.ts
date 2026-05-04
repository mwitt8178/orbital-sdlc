/**
 * cognito-client.test.ts — verifies the feature-flag gate behaves correctly
 * in absence of Cognito IAM. The wrapper MUST return { skipped: true } so
 * the team service can degrade gracefully and surface "pending IAM".
 *
 * [Engineer-Principal · Opus · run-feat-settings-team]
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  adminCreateUser,
  adminDeleteUser,
  adminDisableUser,
  readCognitoEnv,
} from '../../../src/team/cognito-client.js'

const ORIG_ENABLED = process.env.ORBITAL_TEAM_COGNITO_ENABLED
const ORIG_POOL = process.env.ORBITAL_COGNITO_USER_POOL_ID

describe('cognito-client (disabled mode)', () => {
  beforeEach(() => {
    delete process.env.ORBITAL_TEAM_COGNITO_ENABLED
    delete process.env.ORBITAL_COGNITO_USER_POOL_ID
  })
  afterEach(() => {
    if (ORIG_ENABLED !== undefined) process.env.ORBITAL_TEAM_COGNITO_ENABLED = ORIG_ENABLED
    if (ORIG_POOL !== undefined) process.env.ORBITAL_COGNITO_USER_POOL_ID = ORIG_POOL
  })

  it('readCognitoEnv reports disabled when env not set', () => {
    expect(readCognitoEnv()).toEqual({ enabled: false, userPoolId: null })
  })

  it('adminCreateUser skips when disabled', async () => {
    const out = await adminCreateUser({ email: 'team-test@orbital.local' })
    expect(out).toMatchObject({ skipped: true })
    if (out.skipped) expect(out.reason).toContain('ORBITAL_TEAM_COGNITO_ENABLED')
  })

  it('adminDisableUser skips when disabled', async () => {
    const out = await adminDisableUser('team-test@orbital.local')
    expect(out).toMatchObject({ skipped: true })
  })

  it('adminDeleteUser skips when disabled', async () => {
    const out = await adminDeleteUser('team-test@orbital.local')
    expect(out).toMatchObject({ skipped: true })
  })

  it('skips when enabled but pool id missing', async () => {
    process.env.ORBITAL_TEAM_COGNITO_ENABLED = 'true'
    const out = await adminCreateUser({ email: 'x@y.z' })
    expect(out).toMatchObject({ skipped: true })
    if (out.skipped) expect(out.reason).toContain('ORBITAL_COGNITO_USER_POOL_ID')
  })
})
