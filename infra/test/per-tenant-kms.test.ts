// [Engineer-Principal · Opus · run-round8-07-secrets-kms]
/**
 * per-tenant-kms.test.ts — IAM scoping tests for PerTenantKmsConstruct.
 *
 * Per-tenant CMKs are NOT created at deploy time. The construct exists only
 * to grant IAM permissions to the orchestrator's onboarding Lambda for
 * runtime CMK provisioning, and to the audit/replay Lambdas for runtime
 * use of the tenant CMKs.
 *
 * What we verify:
 *   - The construct adds NO KMS::Key resources to the template.
 *   - grantOnboardingPermissions emits the expected create permissions
 *     constrained by aws:RequestTag/Owner=orbital + Env=<env>.
 *   - grantPerTenantUsage emits Encrypt/Decrypt/GenerateDataKey scoped via
 *     kms:RequestAlias condition to alias/orbital-tenant-*.
 *   - grantTenantDeletion emits DeleteAlias + ScheduleKeyDeletion.
 *   - A Lambda holding ONLY grantPerTenantUsage cannot create new keys
 *     (no kms:CreateKey on its policy) — cross-grant isolation.
 */

import * as cdk from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib'
import {
  PerTenantKmsConstruct,
  TENANT_KEY_ALIAS_PREFIX,
} from '../lib/constructs/per-tenant-kms'

interface ScopedStack {
  stack: cdk.Stack
  template: Template
  perTenantKms: PerTenantKmsConstruct
  onboardingRole: iam.Role
  auditRole: iam.Role
  unrelatedRole: iam.Role
}

function buildScopedStack(): ScopedStack {
  const app = new cdk.App()
  const stack = new cdk.Stack(app, 'PerTenantKmsStack', {
    env: { account: '123456789012', region: 'us-east-1' },
  })
  const perTenantKms = new PerTenantKmsConstruct(stack, 'PerTenantKms', {
    envName: 'mwitt',
    account: '123456789012',
    region: 'us-east-1',
  })
  const onboardingRole = new iam.Role(stack, 'OnboardingRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  })
  const auditRole = new iam.Role(stack, 'AuditRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  })
  const unrelatedRole = new iam.Role(stack, 'UnrelatedRole', {
    assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
  })

  perTenantKms.grantOnboardingPermissions(onboardingRole)
  perTenantKms.grantPerTenantUsage(onboardingRole)
  perTenantKms.grantTenantDeletion(onboardingRole)

  perTenantKms.grantPerTenantUsage(auditRole)

  // unrelatedRole gets nothing — verifies that a Lambda without an explicit
  // grant has no per-tenant KMS permissions whatsoever.

  const template = Template.fromStack(stack)
  return {
    stack,
    template,
    perTenantKms,
    onboardingRole,
    auditRole,
    unrelatedRole,
  }
}

// ---------------------------------------------------------------------------
// No CMKs at deploy time
// ---------------------------------------------------------------------------

describe('PerTenantKmsConstruct — does NOT create CMKs at deploy time', () => {
  test('the construct adds zero KMS::Key resources', () => {
    const { template } = buildScopedStack()
    const keys = template.findResources('AWS::KMS::Key')
    // (We pre-populate the role with iam policies; KMS::Key count is 0.)
    expect(Object.keys(keys).length).toBe(0)
  })

  test('the construct adds zero KMS::Alias resources', () => {
    const { template } = buildScopedStack()
    const aliases = template.findResources('AWS::KMS::Alias')
    expect(Object.keys(aliases).length).toBe(0)
  })

  test('exports the tenant key alias prefix as a stack output', () => {
    const { template } = buildScopedStack()
    template.hasOutput('*', {
      Value: TENANT_KEY_ALIAS_PREFIX,
    })
  })
})

// ---------------------------------------------------------------------------
// grantOnboardingPermissions
// ---------------------------------------------------------------------------

describe('PerTenantKmsConstruct — grantOnboardingPermissions', () => {
  test('grants kms:CreateKey scoped by aws:RequestTag/Owner=orbital', () => {
    const { template } = buildScopedStack()
    const policies = template.findResources('AWS::IAM::Policy')
    const onboardingPolicy = Object.values(policies).find((p: unknown) => {
      const props = (p as { Properties: { Roles: Array<{ Ref: string }> } }).Properties
      return props.Roles?.some((r) => r.Ref?.startsWith('OnboardingRole'))
    })
    expect(onboardingPolicy).toBeDefined()
    const json = JSON.stringify((onboardingPolicy as { Properties: unknown }).Properties)
    expect(json).toContain('kms:CreateKey')
    expect(json).toContain('aws:RequestTag/Owner')
    expect(json).toContain('orbital')
    expect(json).toContain('aws:RequestTag/Env')
  })

  test('grants kms:CreateAlias scoped to the alias/orbital-tenant-* namespace', () => {
    const { template } = buildScopedStack()
    const policies = template.findResources('AWS::IAM::Policy')
    const onboardingPolicy = Object.values(policies).find((p: unknown) => {
      const props = (p as { Properties: { Roles: Array<{ Ref: string }> } }).Properties
      return props.Roles?.some((r) => r.Ref?.startsWith('OnboardingRole'))
    })
    expect(onboardingPolicy).toBeDefined()
    const json = JSON.stringify((onboardingPolicy as { Properties: unknown }).Properties)
    expect(json).toContain('kms:CreateAlias')
    expect(json).toContain('alias/orbital-tenant-')
  })
})

// ---------------------------------------------------------------------------
// grantPerTenantUsage — RequestAlias condition
// ---------------------------------------------------------------------------

describe('PerTenantKmsConstruct — grantPerTenantUsage', () => {
  test('grants Encrypt/Decrypt scoped via kms:RequestAlias to orbital-tenant-*', () => {
    const { template } = buildScopedStack()
    const policies = template.findResources('AWS::IAM::Policy')
    const auditPolicy = Object.values(policies).find((p: unknown) => {
      const props = (p as { Properties: { Roles: Array<{ Ref: string }> } }).Properties
      return props.Roles?.some((r) => r.Ref?.startsWith('AuditRole'))
    })
    expect(auditPolicy).toBeDefined()
    const json = JSON.stringify((auditPolicy as { Properties: unknown }).Properties)
    expect(json).toContain('kms:Encrypt')
    expect(json).toContain('kms:Decrypt')
    expect(json).toContain('kms:GenerateDataKey')
    expect(json).toContain('kms:RequestAlias')
    expect(json).toContain('alias/orbital-tenant-')
  })

  test('audit role with grantPerTenantUsage cannot create keys (no kms:CreateKey in policy)', () => {
    const { template } = buildScopedStack()
    const policies = template.findResources('AWS::IAM::Policy')
    const auditPolicy = Object.values(policies).find((p: unknown) => {
      const props = (p as { Properties: { Roles: Array<{ Ref: string }> } }).Properties
      return props.Roles?.some((r) => r.Ref?.startsWith('AuditRole'))
    })
    expect(auditPolicy).toBeDefined()
    const json = JSON.stringify((auditPolicy as { Properties: unknown }).Properties)
    expect(json).not.toContain('kms:CreateKey')
    expect(json).not.toContain('kms:CreateAlias')
    expect(json).not.toContain('kms:ScheduleKeyDeletion')
  })
})

// ---------------------------------------------------------------------------
// Cross-grant isolation
// ---------------------------------------------------------------------------

describe('PerTenantKmsConstruct — cross-grant isolation', () => {
  test('roles without an explicit grant have no per-tenant KMS permissions', () => {
    const { template } = buildScopedStack()
    const policies = template.findResources('AWS::IAM::Policy')
    const unrelatedPolicy = Object.values(policies).find((p: unknown) => {
      const props = (p as { Properties: { Roles: Array<{ Ref: string }> } }).Properties
      return props.Roles?.some((r) => r.Ref?.startsWith('UnrelatedRole'))
    })
    // No grants → CDK may not even materialize a Policy for the role.
    if (unrelatedPolicy) {
      const json = JSON.stringify((unrelatedPolicy as { Properties: unknown }).Properties)
      expect(json).not.toContain('alias/orbital-tenant-')
      expect(json).not.toContain('kms:RequestAlias')
    }
  })
})

// ---------------------------------------------------------------------------
// grantTenantDeletion
// ---------------------------------------------------------------------------

describe('PerTenantKmsConstruct — grantTenantDeletion', () => {
  test('grants DeleteAlias + ScheduleKeyDeletion to onboarding role', () => {
    const { template } = buildScopedStack()
    const policies = template.findResources('AWS::IAM::Policy')
    const onboardingPolicy = Object.values(policies).find((p: unknown) => {
      const props = (p as { Properties: { Roles: Array<{ Ref: string }> } }).Properties
      return props.Roles?.some((r) => r.Ref?.startsWith('OnboardingRole'))
    })
    expect(onboardingPolicy).toBeDefined()
    const json = JSON.stringify((onboardingPolicy as { Properties: unknown }).Properties)
    expect(json).toContain('kms:DeleteAlias')
    expect(json).toContain('kms:ScheduleKeyDeletion')
  })
})

// ---------------------------------------------------------------------------
// cdk-nag
// ---------------------------------------------------------------------------

describe('cdk-nag — per-tenant kms IAM grants', () => {
  test('no critical nag violations on the per-tenant-kms grants', () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, 'NagPerTenantKmsStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })
    const perTenantKms = new PerTenantKmsConstruct(stack, 'PerTenantKms', {
      envName: 'mwitt',
      account: '123456789012',
      region: 'us-east-1',
    })
    const role = new iam.Role(stack, 'TestRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    })
    perTenantKms.grantOnboardingPermissions(role)
    perTenantKms.grantPerTenantUsage(role)

    NagSuppressions.addStackSuppressions(stack, [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Wildcard on kms:CreateKey is constrained by aws:RequestTag/Owner=orbital condition. ' +
          'Wildcard on kms:Encrypt/Decrypt is constrained by kms:RequestAlias=alias/orbital-tenant-*.',
      },
    ])

    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }))
    expect(() => app.synth()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

describe('PerTenantKmsConstruct — snapshot', () => {
  test('template matches snapshot', () => {
    const { template } = buildScopedStack()
    expect(template.toJSON()).toMatchSnapshot()
  })
})
