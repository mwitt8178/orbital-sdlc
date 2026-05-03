/**
 * secret-helpers.ts — Shared helpers for mapping SecretRef to env var names and ARNs.
 *
 * Extracted from orbital-hub-stack.ts so stacks can import without creating
 * a circular dependency with the composition root.
 */
import { SecretsConstruct, SecretRef } from '../constructs/secrets'

/**
 * Convert a secret ref into the canonical Lambda env var name for the secret ARN.
 * The orchestrator runtime reads these env vars in secrets-cache.ts.
 */
export function secretEnvVarName(ref: SecretRef): string {
  switch (ref) {
    case 'hubMasterKey':
      return 'ORBITAL_HUB_MASTER_KEY_SECRET_ARN'
    case 'dbMasterCreds':
      return 'ORBITAL_DB_CREDS_SECRET_ARN'
    case 'githubWebhookSecret':
      return 'ORBITAL_GITHUB_WEBHOOK_SECRET_ARN'
    case 'cognitoAppClientSecret':
      return 'ORBITAL_COGNITO_APP_CLIENT_SECRET_ARN'
  }
}

/**
 * Convert a secret ref into the env var holding the secret NAME (alternative
 * to ARN — some AWS SDK clients are happier with the name).
 */
export function secretNameEnvVar(ref: SecretRef): string {
  return secretEnvVarName(ref).replace('_ARN', '_NAME')
}

export function secretArnFor(secrets: SecretsConstruct, ref: SecretRef): string {
  switch (ref) {
    case 'hubMasterKey':
      return secrets.hubMasterKeySecret.secretArn
    case 'dbMasterCreds':
      return secrets.dbMasterSecret.secretArn
    case 'githubWebhookSecret':
      return secrets.githubWebhookSecret.secretArn
    case 'cognitoAppClientSecret':
      if (!secrets.cognitoAppClientSecret) {
        throw new Error('cognitoAppClientSecret was not provisioned')
      }
      return secrets.cognitoAppClientSecret.secretArn
  }
}
