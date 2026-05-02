#!/usr/bin/env node
/**
 * Orbital CDK App — Round 8
 *
 * Usage:
 *   cdk synth  --context env=mwitt
 *   cdk diff   --context env=mwitt
 *   cdk deploy --context env=mwitt [--require-approval never]
 *
 * Required context key: env = mwitt | rreed | prod
 *
 * Per-env configuration is read from cdk.json's "envs" context block.
 * Account IDs are <TBD> in source — set ORBITAL_ACCOUNT_<ENV> env vars or
 * update cdk.json with real account IDs before deploying.
 */
import 'source-map-support/register'
import * as cdk from 'aws-cdk-lib'
import { OrbitalHubStack, EnvConfig } from '../lib/orbital-hub-stack'

const VALID_ENVS = ['mwitt', 'rreed', 'prod'] as const
type EnvName = (typeof VALID_ENVS)[number]

const app = new cdk.App()

// ---------------------------------------------------------------------------
// Resolve target environment from context
// ---------------------------------------------------------------------------
const envName = app.node.tryGetContext('env') as string | undefined
if (!envName) {
  throw new Error(
    'Missing required context key "env". Pass --context env=mwitt|rreed|prod',
  )
}
if (!VALID_ENVS.includes(envName as EnvName)) {
  throw new Error(
    `Invalid env "${envName}". Must be one of: ${VALID_ENVS.join(', ')}`,
  )
}

// ---------------------------------------------------------------------------
// Load per-env config from cdk.json context
// ---------------------------------------------------------------------------
const envs = app.node.tryGetContext('envs') as
  | Record<string, Partial<EnvConfig>>
  | undefined

if (!envs) {
  throw new Error(
    'Missing "envs" context block in cdk.json. Ensure cdk.json has the envs config.',
  )
}

const rawConfig = envs[envName]
if (!rawConfig) {
  throw new Error(`No config found for env "${envName}" in cdk.json "envs" block.`)
}

// Allow account IDs to be injected via env vars for CI/CD without mutating cdk.json
const accountEnvVar = process.env[`ORBITAL_ACCOUNT_${envName.toUpperCase()}`]
const account = accountEnvVar ?? rawConfig.account ?? '<TBD>'

const envConfig: EnvConfig = {
  account,
  region: rawConfig.region ?? 'us-east-1',
  domain: rawConfig.domain ?? `${envName}.orbital.team.dev`,
  auroraMinAcu: rawConfig.auroraMinAcu ?? 0.5,
  auroraMaxAcu: rawConfig.auroraMaxAcu ?? 4,
  logRetentionDays: rawConfig.logRetentionDays ?? 30,
  enableMfa: rawConfig.enableMfa ?? false,
}

// ---------------------------------------------------------------------------
// Instantiate the single stack
// ---------------------------------------------------------------------------
new OrbitalHubStack(app, `OrbitalHub-${envName}`, {
  envName: envName as EnvName,
  envConfig,

  // Apply stack-level tags visible in AWS Console
  tags: {
    'orbital:env': envName,
    'orbital:managed-by': 'cdk',
  },
})
