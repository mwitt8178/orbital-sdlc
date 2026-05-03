/**
 * auth-stack.ts — Cognito user pool, Secrets Manager secrets, KMS keys,
 * per-tenant KMS IAM scaffolding, key-rotation Lambda.
 *
 * Phase 4 stack split: resources are instantiated directly on the parent scope
 * so logical IDs stay identical to the monolith.
 */
import * as cdk from 'aws-cdk-lib'
import * as rds from 'aws-cdk-lib/aws-rds'
import * as route53 from 'aws-cdk-lib/aws-route53'
import { Construct } from 'constructs'
import { CognitoConstruct } from '../constructs/cognito'
import { SecretsConstruct } from '../constructs/secrets'
import { PerTenantKmsConstruct } from '../constructs/per-tenant-kms'
import { KeyRotationLambdaConstruct } from '../constructs/key-rotation-lambda'
import { EnvConfig } from '../orbital-hub-stack'

export interface AuthOutputs {
  readonly cognito: CognitoConstruct
  readonly secrets: SecretsConstruct
  readonly perTenantKms: PerTenantKmsConstruct
  readonly keyRotation: KeyRotationLambdaConstruct
}

/**
 * Provision auth resources (Cognito, Secrets Manager, KMS) directly on the
 * given scope. The dbMasterSecret produced by AuroraConstruct is required so
 * SecretsConstruct can wire auto-rotation onto it.
 */
export function buildAuthResources(
  scope: Construct,
  envName: string,
  envConfig: EnvConfig,
  dbMasterSecret: rds.DatabaseSecret,
  hostedZone: route53.IHostedZone | undefined,
): AuthOutputs {
  const cognito = new CognitoConstruct(scope, 'Cognito', {
    envName,
    enableMfa: envConfig.enableMfa,
    domain: envConfig.domain,
    hostedZone,
  })

  const secrets = new SecretsConstruct(scope, 'Secrets', {
    envName,
    dbMasterSecret,
    provisionCognitoClientSecret: false,
  })

  const perTenantKms = new PerTenantKmsConstruct(scope, 'PerTenantKms', {
    envName,
    account: cdk.Stack.of(scope).account,
    region: envConfig.region,
  })

  const keyRotation = new KeyRotationLambdaConstruct(scope, 'KeyRotation', {
    envName,
    hubMasterKeySecret: secrets.hubMasterKeySecret,
    encryptionKey: secrets.hubMasterKeyEncryptionKey,
    logRetentionDays: envConfig.logRetentionDays,
    rotationDays: 90,
  })
  // Rotation Lambda is the only caller permitted to write the secret.
  secrets.grantWriteHubMasterKey(keyRotation.fn)

  return { cognito, secrets, perTenantKms, keyRotation }
}
