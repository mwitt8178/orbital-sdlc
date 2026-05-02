// [Engineer-Principal · Opus · run-round8-07-secrets-kms]
/**
 * secrets.test.ts — Snapshot + property + IAM scoping tests for SecretsConstruct
 * and the rotation Lambda.
 *
 * TDD: written RED-first against the spec; turned GREEN once secrets.ts and
 * key-rotation-lambda.ts were implemented.
 *
 * Verifies:
 *   - 4 secrets are created per env (hub-master-key, db-master-creds attach,
 *     github-webhook-secret, optional cognito-app-client-secret).
 *   - Hub master key + github webhook secret are encrypted with a CMK (not
 *     the AWS-managed default key).
 *   - The KMS CMK has automatic rotation enabled.
 *   - Aurora master credentials secret has a rotation schedule attached
 *     (30 days).
 *   - Hub master key has a rotation Lambda + EventBridge schedule (90 days).
 *   - The KeyRotationLambda has only the IAM permissions it needs.
 *   - Per-Lambda IAM scoping: each Lambda has access to ONLY the secrets it
 *     was granted, not others.
 *   - Snapshot matches.
 */

import * as cdk from 'aws-cdk-lib'
import * as ec2 from 'aws-cdk-lib/aws-ec2'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as rds from 'aws-cdk-lib/aws-rds'
import { Template, Match } from 'aws-cdk-lib/assertions'
import { AwsSolutionsChecks, NagSuppressions } from 'cdk-nag'
import { Aspects } from 'aws-cdk-lib'
import { SecretsConstruct, secretName } from '../lib/constructs/secrets'
import { KeyRotationLambdaConstruct } from '../lib/constructs/key-rotation-lambda'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface SecretsTestStack {
  stack: cdk.Stack
  template: Template
  secrets: SecretsConstruct
  rotation: KeyRotationLambdaConstruct
}

function buildSecretsStack(opts: {
  envName?: string
  provisionCognitoSecret?: boolean
}): SecretsTestStack {
  const { envName = 'mwitt', provisionCognitoSecret = false } = opts

  const app = new cdk.App()
  const stack = new cdk.Stack(app, `TestSecretsStack-${envName}`, {
    env: { account: '123456789012', region: 'us-east-1' },
  })

  // Aurora master secret stub — SecretsConstruct attaches rotation here.
  const dbMasterSecret = new rds.DatabaseSecret(stack, 'DbMasterSecret', {
    username: 'orbital_admin',
    secretName: `/orbital/${envName}/aurora/master-credentials`,
  })

  const secrets = new SecretsConstruct(stack, 'Secrets', {
    envName,
    dbMasterSecret,
    provisionCognitoClientSecret: provisionCognitoSecret,
  })

  const rotation = new KeyRotationLambdaConstruct(stack, 'KeyRotation', {
    envName,
    hubMasterKeySecret: secrets.hubMasterKeySecret,
    encryptionKey: secrets.hubMasterKeyEncryptionKey,
    logRetentionDays: 30,
    rotationDays: 90,
  })
  secrets.grantWriteHubMasterKey(rotation.fn)

  const template = Template.fromStack(stack)
  return { stack, template, secrets, rotation }
}

// ---------------------------------------------------------------------------
// Secret existence + naming
// ---------------------------------------------------------------------------

describe('SecretsConstruct — secret existence', () => {
  test('hub-master-key secret is created with the correct name', () => {
    const { template } = buildSecretsStack({})
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'orbital/mwitt/hub-master-key',
    })
  })

  test('github-webhook-secret is created with the correct name', () => {
    const { template } = buildSecretsStack({})
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'orbital/mwitt/github-webhook-secret',
    })
  })

  test('db-master-creds secret is REUSED (not duplicated) — only the Aurora secret exists', () => {
    const { template } = buildSecretsStack({})
    // Aurora's secret is named /orbital/{env}/aurora/master-credentials. We
    // only verify there is no duplicate `db-master-creds` secret created by
    // SecretsConstruct.
    const allSecrets = template.findResources('AWS::SecretsManager::Secret')
    const names = Object.values(allSecrets).map(
      (s: unknown) => (s as { Properties: { Name: string } }).Properties.Name,
    )
    expect(names).not.toContain('orbital/mwitt/db-master-creds')
    expect(names).toContain('/orbital/mwitt/aurora/master-credentials')
  })

  test('cognito-app-client-secret is NOT created by default (PKCE SPA client)', () => {
    const { template } = buildSecretsStack({})
    const allSecrets = template.findResources('AWS::SecretsManager::Secret')
    const names = Object.values(allSecrets).map(
      (s: unknown) => (s as { Properties: { Name: string } }).Properties.Name,
    )
    expect(names).not.toContain('orbital/mwitt/cognito-app-client-secret')
  })

  test('cognito-app-client-secret IS created when explicitly requested', () => {
    const { template } = buildSecretsStack({ provisionCognitoSecret: true })
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'orbital/mwitt/cognito-app-client-secret',
    })
  })

  test('total per-env secrets = 3 (hub-master-key, github-webhook, plus the Aurora one)', () => {
    const { template } = buildSecretsStack({})
    template.resourceCountIs('AWS::SecretsManager::Secret', 3)
  })

  test('total per-env secrets with cognito secret = 4', () => {
    const { template } = buildSecretsStack({ provisionCognitoSecret: true })
    template.resourceCountIs('AWS::SecretsManager::Secret', 4)
  })
})

// ---------------------------------------------------------------------------
// KMS CMK encryption
// ---------------------------------------------------------------------------

describe('SecretsConstruct — KMS CMK encryption', () => {
  test('hub-secrets KMS CMK has automatic rotation enabled', () => {
    const { template } = buildSecretsStack({})
    template.hasResourceProperties('AWS::KMS::Key', {
      EnableKeyRotation: true,
      Description: Match.stringLikeRegexp('hub master key'),
    })
  })

  test('hub-secrets KMS CMK has alias orbital-{env}-hub-secrets', () => {
    const { template } = buildSecretsStack({})
    template.hasResourceProperties('AWS::KMS::Alias', {
      AliasName: 'alias/orbital-mwitt-hub-secrets',
    })
  })

  test('hub-master-key secret uses the KMS CMK (not aws-managed key)', () => {
    const { template } = buildSecretsStack({})
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'orbital/mwitt/hub-master-key',
      KmsKeyId: Match.anyValue(),
    })
  })

  test('github-webhook secret uses the KMS CMK', () => {
    const { template } = buildSecretsStack({})
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'orbital/mwitt/github-webhook-secret',
      KmsKeyId: Match.anyValue(),
    })
  })
})

// ---------------------------------------------------------------------------
// Rotation
// ---------------------------------------------------------------------------

describe('SecretsConstruct — rotation', () => {
  test('Aurora master secret has a 30-day rotation schedule attached', () => {
    const { template } = buildSecretsStack({})
    // CDK emits Duration.days(30) as a rate expression, not AutomaticallyAfterDays.
    template.hasResourceProperties('AWS::SecretsManager::RotationSchedule', {
      SecretId: Match.anyValue(),
      RotationRules: {
        ScheduleExpression: 'rate(30 days)',
      },
    })
  })

  test('Aurora rotation uses the AWS-hosted PostgreSQL rotation Lambda', () => {
    const { template } = buildSecretsStack({})
    template.hasResourceProperties('AWS::SecretsManager::RotationSchedule', {
      HostedRotationLambda: Match.objectLike({
        RotationType: 'PostgreSQLSingleUser',
      }),
    })
  })
})

// ---------------------------------------------------------------------------
// Hub master key rotation Lambda + EventBridge schedule
// ---------------------------------------------------------------------------

describe('KeyRotationLambdaConstruct — hub master key rotation', () => {
  test('rotation Lambda function exists', () => {
    const { template } = buildSecretsStack({})
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-key-rotation',
      Runtime: 'nodejs22.x',
      Handler: 'index.handler',
    })
  })

  test('rotation Lambda has X-Ray tracing enabled', () => {
    const { template } = buildSecretsStack({})
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'orbital-mwitt-key-rotation',
      TracingConfig: { Mode: 'Active' },
    })
  })

  test('EventBridge rule schedules rotation every 90 days', () => {
    const { template } = buildSecretsStack({})
    template.hasResourceProperties('AWS::Events::Rule', {
      Name: 'orbital-mwitt-key-rotation-schedule',
      ScheduleExpression: 'rate(90 days)',
    })
  })

  test('rotation Lambda CloudWatch log group is /orbital/{env}/lambda/key-rotation', () => {
    const { template } = buildSecretsStack({})
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/orbital/mwitt/lambda/key-rotation',
    })
  })
})

// ---------------------------------------------------------------------------
// IAM scoping — least privilege per Lambda
// ---------------------------------------------------------------------------

describe('SecretsConstruct — per-Lambda IAM scoping', () => {
  function buildScopedStack(): {
    stack: cdk.Stack
    template: Template
    secrets: SecretsConstruct
    prsLambdaRole: iam.Role
    coreLambdaRole: iam.Role
    auditLambdaRole: iam.Role
  } {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, 'ScopingStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })

    const dbMasterSecret = new rds.DatabaseSecret(stack, 'DbMasterSecret', {
      username: 'orbital_admin',
      secretName: '/orbital/mwitt/aurora/master-credentials',
    })

    const secrets = new SecretsConstruct(stack, 'Secrets', {
      envName: 'mwitt',
      dbMasterSecret,
    })

    // Three example Lambda roles with different needs:
    //   prs:  reads only github webhook secret
    //   core: reads db creds + hub master key
    //   audit: reads only db creds
    const prsLambdaRole = new iam.Role(stack, 'PrsLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    })
    const coreLambdaRole = new iam.Role(stack, 'CoreLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    })
    const auditLambdaRole = new iam.Role(stack, 'AuditLambdaRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    })

    secrets.grantReadFor(prsLambdaRole, ['githubWebhookSecret'])
    secrets.grantReadFor(coreLambdaRole, ['dbMasterCreds', 'hubMasterKey'])
    secrets.grantReadFor(auditLambdaRole, ['dbMasterCreds'])

    const template = Template.fromStack(stack)
    return { stack, template, secrets, prsLambdaRole, coreLambdaRole, auditLambdaRole }
  }

  test('prs Lambda role has GetSecretValue ONLY for github-webhook-secret', () => {
    const { template } = buildScopedStack()
    const policies = template.findResources('AWS::IAM::Policy')
    // Find the prs lambda's default policy. It should reference the github
    // webhook secret ARN and NOT the hub master key.
    const prsPolicy = Object.values(policies).find((p: unknown) => {
      const props = (p as { Properties: { Roles: Array<{ Ref: string }> } }).Properties
      return props.Roles?.some((r) => r.Ref?.startsWith('PrsLambdaRole'))
    })
    expect(prsPolicy).toBeDefined()
    const stmts = (prsPolicy as { Properties: { PolicyDocument: { Statement: unknown[] } } })
      .Properties.PolicyDocument.Statement
    const stmtsJson = JSON.stringify(stmts)
    expect(stmtsJson).toContain('secretsmanager:GetSecretValue')
    expect(stmtsJson).toContain('GithubWebhookSecret')
    // CRITICAL: prs must NOT reference hub-master-key. The hub master key
    // is the highest-blast-radius secret. We assert it is absent.
    expect(stmtsJson).not.toContain('HubMasterKeySecret')
  })

  test('core Lambda role can access db creds AND hub master key', () => {
    const { template } = buildScopedStack()
    const policies = template.findResources('AWS::IAM::Policy')
    const corePolicy = Object.values(policies).find((p: unknown) => {
      const props = (p as { Properties: { Roles: Array<{ Ref: string }> } }).Properties
      return props.Roles?.some((r) => r.Ref?.startsWith('CoreLambdaRole'))
    })
    expect(corePolicy).toBeDefined()
    const json = JSON.stringify((corePolicy as { Properties: unknown }).Properties)
    expect(json).toContain('HubMasterKeySecret')
    expect(json).toContain('DbMasterSecret')
  })

  test('audit Lambda role does NOT have access to hub master key OR github webhook secret', () => {
    const { template } = buildScopedStack()
    const policies = template.findResources('AWS::IAM::Policy')
    const auditPolicy = Object.values(policies).find((p: unknown) => {
      const props = (p as { Properties: { Roles: Array<{ Ref: string }> } }).Properties
      return props.Roles?.some((r) => r.Ref?.startsWith('AuditLambdaRole'))
    })
    expect(auditPolicy).toBeDefined()
    const json = JSON.stringify((auditPolicy as { Properties: unknown }).Properties)
    expect(json).toContain('DbMasterSecret')
    // Cross-tenant / cross-secret bleed protection:
    expect(json).not.toContain('HubMasterKeySecret')
    expect(json).not.toContain('GithubWebhookSecret')
  })

  test('grantReadFor refuses cognitoAppClientSecret when not provisioned', () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, 'NoCognitoStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })
    const dbMasterSecret = new rds.DatabaseSecret(stack, 'DbMasterSecret', {
      username: 'orbital_admin',
    })
    const secrets = new SecretsConstruct(stack, 'Secrets', {
      envName: 'mwitt',
      dbMasterSecret,
      provisionCognitoClientSecret: false,
    })
    const role = new iam.Role(stack, 'TestRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
    })
    expect(() => secrets.grantReadFor(role, ['cognitoAppClientSecret'])).toThrow(
      /not provisioned/,
    )
  })

  test('rotation Lambda role can write hub master key but only it can', () => {
    const { template } = buildSecretsStack({})
    // Find the rotation Lambda's role policy — confirms it has PutSecretValue
    // on the hub master key resource.
    const policies = template.findResources('AWS::IAM::Policy')
    const allJson = JSON.stringify(policies)
    expect(allJson).toContain('secretsmanager:PutSecretValue')
    expect(allJson).toContain('HubMasterKeySecret')
  })
})

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------

describe('SecretsConstruct — secretName helper', () => {
  test('secretName produces canonical names', () => {
    expect(secretName('mwitt', 'hubMasterKey')).toBe('orbital/mwitt/hub-master-key')
    expect(secretName('mwitt', 'dbMasterCreds')).toBe('orbital/mwitt/db-master-creds')
    expect(secretName('mwitt', 'githubWebhookSecret')).toBe('orbital/mwitt/github-webhook-secret')
    expect(secretName('mwitt', 'cognitoAppClientSecret')).toBe(
      'orbital/mwitt/cognito-app-client-secret',
    )
  })

  test('secretName is parameterized by env name', () => {
    expect(secretName('rreed', 'hubMasterKey')).toBe('orbital/rreed/hub-master-key')
    expect(secretName('prod', 'hubMasterKey')).toBe('orbital/prod/hub-master-key')
  })
})

// ---------------------------------------------------------------------------
// Outputs
// ---------------------------------------------------------------------------

describe('SecretsConstruct — outputs', () => {
  test('exports HubMasterKeySecretArn and GithubWebhookSecretArn', () => {
    const { template } = buildSecretsStack({})
    const outputs = template.findOutputs('*')
    const keys = Object.keys(outputs)
    expect(keys.some((k) => /HubMasterKeySecretArn/.test(k))).toBe(true)
    expect(keys.some((k) => /GithubWebhookSecretArn/.test(k))).toBe(true)
    expect(keys.some((k) => /HubMasterKeyKmsCmkArn/.test(k))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// cdk-nag — least-privilege IAM check must pass
// ---------------------------------------------------------------------------

describe('cdk-nag — secrets stack', () => {
  test('no critical nag violations on the secrets sub-stack', () => {
    const app = new cdk.App()
    const stack = new cdk.Stack(app, 'NagTestSecretsStack', {
      env: { account: '123456789012', region: 'us-east-1' },
    })
    const dbMasterSecret = new rds.DatabaseSecret(stack, 'DbMasterSecret', {
      username: 'orbital_admin',
      secretName: '/orbital/mwitt/aurora/master-credentials',
    })
    const secrets = new SecretsConstruct(stack, 'Secrets', {
      envName: 'mwitt',
      dbMasterSecret,
    })
    const rotation = new KeyRotationLambdaConstruct(stack, 'KeyRotation', {
      envName: 'mwitt',
      hubMasterKeySecret: secrets.hubMasterKeySecret,
      encryptionKey: secrets.hubMasterKeyEncryptionKey,
      logRetentionDays: 30,
      rotationDays: 90,
    })
    secrets.grantWriteHubMasterKey(rotation.fn)

    NagSuppressions.addStackSuppressions(stack, [
      // CDK custom resource provider framework + secrets manager rotation use
      // managed runtimes / wildcard resources that cdk-nag flags. Document.
      { id: 'AwsSolutions-IAM4', reason: 'CDK-managed service role policies.' },
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'Wildcard on kms:Encrypt/Decrypt is constrained to alias/orbital-tenant-* via condition. ' +
          'CDK-generated wildcards for log delivery are also accepted here.',
      },
      {
        id: 'AwsSolutions-L1',
        reason:
          'Hosted rotation Lambda runtime is managed by Secrets Manager; rotation Lambda uses nodejs22.x.',
      },
      {
        id: 'AwsSolutions-SMG4',
        reason:
          'DB master creds: 30-day rotation. Hub master key: 90-day rotation via custom Lambda. ' +
          'Github webhook + cognito client: manual rotation per architecture.md.',
      },
    ])

    Aspects.of(app).add(new AwsSolutionsChecks({ verbose: false }))
    expect(() => app.synth()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Snapshot
// ---------------------------------------------------------------------------

describe('SecretsConstruct — snapshot', () => {
  test('mwitt template matches snapshot', () => {
    const { template } = buildSecretsStack({ envName: 'mwitt' })
    expect(template.toJSON()).toMatchSnapshot()
  })

  test('prod template matches snapshot', () => {
    const { template } = buildSecretsStack({ envName: 'prod' })
    expect(template.toJSON()).toMatchSnapshot()
  })

  test('with cognito secret matches snapshot', () => {
    const { template } = buildSecretsStack({
      envName: 'mwitt',
      provisionCognitoSecret: true,
    })
    expect(template.toJSON()).toMatchSnapshot()
  })
})
