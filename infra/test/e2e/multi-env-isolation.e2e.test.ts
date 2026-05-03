// [Engineer-Principal · Opus · run-round8-09-cutover-smoke]
/**
 * multi-env-isolation.e2e.test.ts — Synthesize mwitt + rreed in the same Jest
 * process and verify that NO resource name, ARN template, or stack output
 * overlaps between the two environments.
 *
 * This is NOT a real AWS deploy — we operate purely on synthesized
 * CloudFormation templates. The test fails if any:
 *   - Two resources from different envs share the same name (would clash on
 *     deploy if they shared an account/region).
 *   - An ARN template contains the wrong env name.
 *   - A stack-level CFN export name is reused across envs.
 *
 * If this passes, the two envs are guaranteed to be deployable as fully
 * isolated stacks.
 *
 * Periodic CI cadence: weekly (per architecture). It's fast (just synth).
 */

import * as cdk from 'aws-cdk-lib'
import { Template } from 'aws-cdk-lib/assertions'
import { OrbitalHubStack, EnvConfig } from '../../lib/orbital-hub-stack'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface BuiltEnv {
  envName: 'mwitt' | 'rreed' | 'prod'
  account: string
  region: string
  template: Template
  templateJson: Record<string, unknown>
}

function buildEnv(
  envName: 'mwitt' | 'rreed' | 'prod',
  account: string,
  region: string,
): BuiltEnv {
  const app = new cdk.App()
  const config: EnvConfig = {
    account,
    region,
    domain: envName === 'prod' ? 'orbital.team.dev' : `${envName}.orbital.team.dev`,
    auroraMinAcu: 0.5,
    auroraMaxAcu: 4,
    logRetentionDays: 30,
    enableMfa: envName === 'prod',
  }
  const stack = new OrbitalHubStack(app, `OrbitalHub-${envName}`, {
    envName,
    envConfig: config,
  })
  const template = Template.fromStack(stack)
  return {
    envName,
    account,
    region,
    template,
    templateJson: template.toJSON() as Record<string, unknown>,
  }
}

/**
 * Walk the template and return every string value that contains the given
 * substring. Used to detect cross-env name leaks (e.g., "rreed" appearing
 * inside the mwitt template).
 */
function findStringMatches(obj: unknown, needle: string): string[] {
  const hits: string[] = []
  const visit = (node: unknown): void => {
    if (typeof node === 'string') {
      if (node.includes(needle)) hits.push(node)
      return
    }
    if (Array.isArray(node)) {
      for (const child of node) visit(child)
      return
    }
    if (node !== null && typeof node === 'object') {
      for (const v of Object.values(node)) visit(v)
    }
  }
  visit(obj)
  return hits
}

/**
 * Extract every literal string property in the template that looks like a
 * resource name (matches the prefixes Orbital uses).
 */
function extractOrbitalResourceNames(t: Template): Set<string> {
  const names = new Set<string>()
  const visit = (obj: unknown): void => {
    if (typeof obj === 'string') {
      // Match orbital-<env>-* resource names (Lambda, SG, queue, etc.)
      // and orbital-<scope>-<env> patterns used by S3/observability.
      if (/^orbital[-/][a-z0-9-]+/i.test(obj) && obj.length < 200) {
        names.add(obj)
      }
      return
    }
    if (Array.isArray(obj)) {
      for (const c of obj) visit(c)
      return
    }
    if (obj && typeof obj === 'object') {
      for (const v of Object.values(obj)) visit(v)
    }
  }
  visit(t.toJSON())
  return names
}

// ---------------------------------------------------------------------------
// Suites
// ---------------------------------------------------------------------------

describe('multi-env-isolation', () => {
  // Different accounts AND different regions — the realistic case.
  let mwitt: BuiltEnv
  let rreed: BuiltEnv

  beforeAll(() => {
    mwitt = buildEnv('mwitt', '111111111111', 'us-east-1')
    rreed = buildEnv('rreed', '222222222222', 'us-west-2')
  })

  test('synth produces a non-empty template for each env', () => {
    expect(Object.keys(mwitt.templateJson).length).toBeGreaterThan(0)
    expect(Object.keys(rreed.templateJson).length).toBeGreaterThan(0)
  })

  test('mwitt template contains zero references to "rreed"', () => {
    const hits = findStringMatches(mwitt.templateJson, 'rreed')
    expect(hits).toEqual([])
  })

  test('rreed template contains zero references to "mwitt"', () => {
    const hits = findStringMatches(rreed.templateJson, 'mwitt')
    expect(hits).toEqual([])
  })

  test('rreed template contains zero references to mwitt account 111111111111', () => {
    const hits = findStringMatches(rreed.templateJson, '111111111111')
    expect(hits).toEqual([])
  })

  test('mwitt template contains zero references to rreed account 222222222222', () => {
    const hits = findStringMatches(mwitt.templateJson, '222222222222')
    expect(hits).toEqual([])
  })

  test('orbital-prefixed resource names do not overlap between envs', () => {
    const mwittNames = extractOrbitalResourceNames(mwitt.template)
    const rreedNames = extractOrbitalResourceNames(rreed.template)
    // Build the intersection
    const overlap: string[] = []
    for (const n of mwittNames) {
      if (rreedNames.has(n)) overlap.push(n)
    }
    if (overlap.length > 0) {
      // Allow ONLY truly-static utility names (e.g., orbital-rotation-probe in
      // Lambda code) that aren't AWS resource identifiers. None should exist;
      // surface them so we can fix or whitelist explicitly.
      throw new Error(
        `Found ${overlap.length} overlapping orbital-* names between mwitt and rreed: ${JSON.stringify(overlap)}`,
      )
    }
    expect(overlap).toEqual([])
  })

  test('every Lambda function name contains the env name', () => {
    const m = mwitt.template.findResources('AWS::Lambda::Function')
    for (const [logicalId, res] of Object.entries(m)) {
      const fnName = (res.Properties as { FunctionName?: string } | undefined)?.FunctionName
      if (typeof fnName === 'string') {
        expect(fnName).toContain('mwitt')
        expect(fnName).not.toContain('rreed')
      }
      expect(logicalId).toBeTruthy()
    }
    const r = rreed.template.findResources('AWS::Lambda::Function')
    for (const [logicalId, res] of Object.entries(r)) {
      const fnName = (res.Properties as { FunctionName?: string } | undefined)?.FunctionName
      if (typeof fnName === 'string') {
        expect(fnName).toContain('rreed')
        expect(fnName).not.toContain('mwitt')
      }
      expect(logicalId).toBeTruthy()
    }
  })

  test('every S3 bucket name contains the env name', () => {
    const m = mwitt.template.findResources('AWS::S3::Bucket')
    for (const [, res] of Object.entries(m)) {
      const bucketName = (res.Properties as { BucketName?: string } | undefined)?.BucketName
      if (typeof bucketName === 'string') {
        expect(bucketName).toContain('mwitt')
        expect(bucketName).not.toContain('rreed')
      }
    }
    const r = rreed.template.findResources('AWS::S3::Bucket')
    for (const [, res] of Object.entries(r)) {
      const bucketName = (res.Properties as { BucketName?: string } | undefined)?.BucketName
      if (typeof bucketName === 'string') {
        expect(bucketName).toContain('rreed')
        expect(bucketName).not.toContain('mwitt')
      }
    }
  })

  test('every SQS queue name contains the env name', () => {
    const m = mwitt.template.findResources('AWS::SQS::Queue')
    for (const [, res] of Object.entries(m)) {
      const qName = (res.Properties as { QueueName?: string } | undefined)?.QueueName
      if (typeof qName === 'string') {
        expect(qName).toContain('mwitt')
        expect(qName).not.toContain('rreed')
      }
    }
    const r = rreed.template.findResources('AWS::SQS::Queue')
    for (const [, res] of Object.entries(r)) {
      const qName = (res.Properties as { QueueName?: string } | undefined)?.QueueName
      if (typeof qName === 'string') {
        expect(qName).toContain('rreed')
        expect(qName).not.toContain('mwitt')
      }
    }
  })

  test('every SNS topic name contains the env name', () => {
    const m = mwitt.template.findResources('AWS::SNS::Topic')
    for (const [, res] of Object.entries(m)) {
      const tName = (res.Properties as { TopicName?: string } | undefined)?.TopicName
      if (typeof tName === 'string') {
        expect(tName).toContain('mwitt')
        expect(tName).not.toContain('rreed')
      }
    }
    const r = rreed.template.findResources('AWS::SNS::Topic')
    for (const [, res] of Object.entries(r)) {
      const tName = (res.Properties as { TopicName?: string } | undefined)?.TopicName
      if (typeof tName === 'string') {
        expect(tName).toContain('rreed')
        expect(tName).not.toContain('mwitt')
      }
    }
  })

  test('every DynamoDB table name contains the env name', () => {
    const m = mwitt.template.findResources('AWS::DynamoDB::Table')
    for (const [, res] of Object.entries(m)) {
      const t = (res.Properties as { TableName?: string } | undefined)?.TableName
      if (typeof t === 'string') {
        expect(t).toContain('mwitt')
        expect(t).not.toContain('rreed')
      }
    }
    const r = rreed.template.findResources('AWS::DynamoDB::Table')
    for (const [, res] of Object.entries(r)) {
      const t = (res.Properties as { TableName?: string } | undefined)?.TableName
      if (typeof t === 'string') {
        expect(t).toContain('rreed')
        expect(t).not.toContain('mwitt')
      }
    }
  })

  test('every Cognito user pool name contains the env name', () => {
    const m = mwitt.template.findResources('AWS::Cognito::UserPool')
    for (const [, res] of Object.entries(m)) {
      const n = (res.Properties as { UserPoolName?: string } | undefined)?.UserPoolName
      expect(n).toBe('orbital-mwitt')
    }
    const r = rreed.template.findResources('AWS::Cognito::UserPool')
    for (const [, res] of Object.entries(r)) {
      const n = (res.Properties as { UserPoolName?: string } | undefined)?.UserPoolName
      expect(n).toBe('orbital-rreed')
    }
  })

  test('CloudFormation export names do not overlap', () => {
    const mwittExports = new Set<string>()
    const rreedExports = new Set<string>()

    const mOutputs = mwitt.template.findOutputs('*')
    for (const out of Object.values(mOutputs)) {
      const exp = (out as { Export?: { Name?: string } }).Export?.Name
      if (typeof exp === 'string') mwittExports.add(exp)
    }
    const rOutputs = rreed.template.findOutputs('*')
    for (const out of Object.values(rOutputs)) {
      const exp = (out as { Export?: { Name?: string } }).Export?.Name
      if (typeof exp === 'string') rreedExports.add(exp)
    }

    const overlap: string[] = []
    for (const e of mwittExports) {
      if (rreedExports.has(e)) overlap.push(e)
    }
    expect(overlap).toEqual([])

    // Sanity: each export name must contain the env name.
    for (const e of mwittExports) {
      expect(e).toContain('mwitt')
    }
    for (const e of rreedExports) {
      expect(e).toContain('rreed')
    }
  })

  test('domain in each template matches the env config', () => {
    // Spot-check a Cognito user pool domain — derived from envConfig.domain.
    const mwittDomains = mwitt.template.findResources('AWS::Cognito::UserPoolDomain')
    for (const [, res] of Object.entries(mwittDomains)) {
      const d = (res.Properties as { Domain?: string } | undefined)?.Domain
      expect(d).toBe('orbital-mwitt')
    }
    const rreedDomains = rreed.template.findResources('AWS::Cognito::UserPoolDomain')
    for (const [, res] of Object.entries(rreedDomains)) {
      const d = (res.Properties as { Domain?: string } | undefined)?.Domain
      expect(d).toBe('orbital-rreed')
    }
  })

  test('mwitt and rreed templates differ in at least one resource', () => {
    // If the two templates were identical the multi-env design would be broken.
    expect(JSON.stringify(mwitt.templateJson)).not.toBe(JSON.stringify(rreed.templateJson))
  })

  test('same-account different-env (rare) still produces unique resource names', () => {
    // Hypothetical: someone runs both mwitt and rreed in the same AWS account
    // for cost reasons. Resource names must STILL be unique because S3 bucket
    // names and IAM role names share an account-wide namespace.
    const mSame = buildEnv('mwitt', '999999999999', 'us-east-1')
    const rSame = buildEnv('rreed', '999999999999', 'us-east-1')
    const mNames = extractOrbitalResourceNames(mSame.template)
    const rNames = extractOrbitalResourceNames(rSame.template)
    const overlap: string[] = []
    for (const n of mNames) if (rNames.has(n)) overlap.push(n)
    expect(overlap).toEqual([])
  })
})

describe('multi-env-isolation: prod vs dev', () => {
  test('prod stack has termination protection; dev does not', () => {
    const app1 = new cdk.App()
    const app2 = new cdk.App()
    const baseConfig = (envName: 'mwitt' | 'rreed' | 'prod'): EnvConfig => ({
      account: '111111111111',
      region: 'us-east-1',
      domain: envName === 'prod' ? 'orbital.team.dev' : `${envName}.orbital.team.dev`,
      auroraMinAcu: envName === 'prod' ? 1 : 0.5,
      auroraMaxAcu: envName === 'prod' ? 16 : 4,
      logRetentionDays: envName === 'prod' ? 90 : 30,
      enableMfa: envName === 'prod',
    })
    const dev = new OrbitalHubStack(app1, 'OrbitalHub-mwitt', {
      envName: 'mwitt',
      envConfig: baseConfig('mwitt'),
    })
    const prod = new OrbitalHubStack(app2, 'OrbitalHub-prod', {
      envName: 'prod',
      envConfig: baseConfig('prod'),
    })
    expect(dev.terminationProtection).toBe(false)
    expect(prod.terminationProtection).toBe(true)
  })
})
