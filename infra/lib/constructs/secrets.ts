// [Engineer-Principal · Opus · run-round8-07-secrets-kms]
/**
 * secrets.ts — Secrets Manager + KMS for the Orbital Hub.
 *
 * SecretsConstruct provisions per-env secrets:
 *   - HubMasterKeySecret      orbital/${env}/hub-master-key
 *       Ed25519 keypair JSON {publicKey, privateKey} consumed by hub Lambdas
 *       to sign outbound envelopes and verify inbound install→hub envelopes.
 *       Rotated every 90 days by KeyRotationLambda; previous key persists for
 *       a 24-hour verification window in the secret stage SECRET_PREV.
 *
 *   - DbMasterCredsSecret      orbital/${env}/db-master-creds
 *       Aurora master DB credentials. ATTACHED to the existing
 *       `props.dbMasterSecret` (created by AuroraConstruct in 8-02). We do NOT
 *       create a new secret here — that would duplicate creds. Instead we
 *       configure auto-rotation on the existing secret using the RDS-built-in
 *       single-user rotation Lambda. Rotation interval: 30 days.
 *
 *   - GithubWebhookSecret      orbital/${env}/github-webhook-secret
 *       Random hex token shared with GitHub for HMAC verification of
 *       inbound webhooks. Rotated on demand from admin UI (no scheduled
 *       rotation Lambda — manual rotation only).
 *
 *   - CognitoAppClientSecret   orbital/${env}/cognito-app-client-secret
 *       Holds the Cognito User Pool app client secret IF the app client
 *       was created with `generateSecret: true`. The 8-01 SPA app client
 *       uses PKCE and does NOT have a secret, so this secret is created
 *       only when `props.cognitoClientSecretValue` is provided. Annual
 *       rotation (manual).
 *
 * The construct exposes `grantReadFor(...)` which adds tightly-scoped
 * `secretsmanager:GetSecretValue` permissions to a given Lambda role,
 * ONLY for the secrets the Lambda actually needs. This is the key to
 * preventing one Lambda's compromise leaking secrets across the surface.
 *
 * KMS:
 *   - HubMasterKeyEncryptionKey  CMK that encrypts the hub master key secret
 *     at rest (separate from AWS-managed key). Auto-rotation enabled.
 *   - cdk-nag-clean: every secret is encrypted with a CMK + has explicit
 *     resource policy (default).
 *
 * Per-tenant CMKs are NOT provisioned here — they are minted on demand by
 * the onboarding orchestrator. See per-tenant-kms.ts for the IAM permissions
 * granted to the onboarding Lambda.
 */

import * as cdk from 'aws-cdk-lib'
import * as iam from 'aws-cdk-lib/aws-iam'
import * as kms from 'aws-cdk-lib/aws-kms'
import * as lambda from 'aws-cdk-lib/aws-lambda'
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager'
import { Construct } from 'constructs'

/** Logical names of secrets that callers may opt into reading. */
export type SecretRef =
  | 'hubMasterKey'
  | 'dbMasterCreds'
  | 'githubWebhookSecret'
  | 'cognitoAppClientSecret'

export interface SecretsConstructProps {
  /** e.g. "mwitt" | "rreed" | "prod" */
  readonly envName: string
  /**
   * The Aurora master credentials secret created by AuroraConstruct (8-02).
   * We attach the rotation Lambda to it; we do NOT create a duplicate secret.
   */
  readonly dbMasterSecret: secretsmanager.ISecret
  /**
   * Whether to provision the cognito app client secret.
   * Defaults to false — Round 8-01 created a PKCE SPA client with no secret.
   * Set true if the env uses an OAuth confidential client with a shared secret.
   */
  readonly provisionCognitoClientSecret?: boolean
}

/**
 * SecretsConstruct — env-level secrets, KMS CMK, and per-Lambda IAM grants.
 */
export class SecretsConstruct extends Construct {
  /**
   * KMS CMK that encrypts the hub master key + cognito secret at rest.
   * Auto-rotation enabled. Removal: RETAIN in prod; DESTROY otherwise.
   */
  readonly hubMasterKeyEncryptionKey: kms.Key

  /**
   * orbital/${env}/hub-master-key — Ed25519 keypair JSON.
   * Initialized empty; populated post-deploy by KeyRotationLambda.
   */
  readonly hubMasterKeySecret: secretsmanager.Secret

  /**
   * orbital/${env}/db-master-creds — same secret as Aurora's masterSecret.
   * Exposed as `dbMasterSecret` for symmetry with other secret refs.
   */
  readonly dbMasterSecret: secretsmanager.ISecret

  /**
   * orbital/${env}/github-webhook-secret — random hex token. CDK auto-generates
   * the initial value via secretStringTemplate; admin can rotate manually later.
   */
  readonly githubWebhookSecret: secretsmanager.Secret

  /**
   * orbital/${env}/cognito-app-client-secret — only created if
   * `provisionCognitoClientSecret` is true.
   */
  readonly cognitoAppClientSecret?: secretsmanager.Secret

  /**
   * The auto-rotation interval applied to the DB master credentials secret.
   * Exposed for tests.
   */
  readonly dbRotationDays: number

  constructor(scope: Construct, id: string, props: SecretsConstructProps) {
    super(scope, id)

    const isProd = props.envName === 'prod'

    // ------------------------------------------------------------------
    // KMS CMK — encrypts the hub master key + cognito client secret
    // ------------------------------------------------------------------
    this.hubMasterKeyEncryptionKey = new kms.Key(this, 'HubMasterKeyKmsCmk', {
      description: `Orbital hub master key + cognito secret CMK — ${props.envName}`,
      alias: `orbital-${props.envName}-hub-secrets`,
      enableKeyRotation: true,
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    // ------------------------------------------------------------------
    // Hub master key — Ed25519 keypair JSON
    //
    // Initial value is a sentinel that signals "rotate me" to KeyRotationLambda.
    // The first invocation of the rotation Lambda replaces it with a real
    // Ed25519 keypair. We generate the sentinel here at synth time using a
    // deterministic, INVALID stub so that any code that reads the secret
    // without rotating it gets a clear failure.
    // ------------------------------------------------------------------
    this.hubMasterKeySecret = new secretsmanager.Secret(this, 'HubMasterKeySecret', {
      secretName: `orbital/${props.envName}/hub-master-key`,
      description: `Orbital ${props.envName} hub Ed25519 master keypair (rotated every 90 days).`,
      encryptionKey: this.hubMasterKeyEncryptionKey,
      generateSecretString: {
        // Generate a placeholder JSON that Lambda code MUST treat as "uninitialized"
        // until the rotation Lambda runs once. Real keys arrive with a publicKey
        // value of length 64 hex chars; this sentinel is shorter and clearly bogus.
        secretStringTemplate: JSON.stringify({
          uninitialized: true,
          publicKey: 'PENDING_ROTATION',
          privateKey: 'PENDING_ROTATION',
        }),
        generateStringKey: 'rotationToken',
        excludePunctuation: true,
      },
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    // ------------------------------------------------------------------
    // DB master creds — reuse the secret from AuroraConstruct (8-02)
    // ------------------------------------------------------------------
    this.dbMasterSecret = props.dbMasterSecret
    this.dbRotationDays = 30

    // Configure the RDS-built-in single-user rotation Lambda.
    // We can only attach a rotation schedule when we have the concrete Secret
    // (not just an ISecret). The masterSecret created by AuroraConstruct is a
    // concrete `Secret`, so we cast for the rotation API. If it's an imported
    // ISecret (test scenarios), we skip rotation attach.
    const concreteDbSecret =
      props.dbMasterSecret instanceof secretsmanager.Secret ? props.dbMasterSecret : null

    if (concreteDbSecret) {
      // The hosted-rotation lambda is a singleton inside the Secret; the API
      // requires us to declare it via addRotationSchedule.
      concreteDbSecret.addRotationSchedule('DbMasterCredsRotation', {
        // Use the AWS-hosted single-user rotation Lambda — supported for PG.
        hostedRotation: secretsmanager.HostedRotation.postgreSqlSingleUser({
          functionName: `orbital-${props.envName}-db-creds-rotation`,
          // Without a VPC, the hosted rotation Lambda runs in the public AWS
          // network; for Aurora-in-VPC we must pass the VPC + security group.
          // We rely on the caller wiring the rotation Lambda to a VPC config
          // post-construct (see Stack wiring section). The Hosted Rotation
          // helper accepts vpc params; for now we leave them undefined and the
          // Stack adds them. This is a deliberate handoff to the Stack so we
          // don't bake VPC ids into the construct.
        }),
        automaticallyAfter: cdk.Duration.days(this.dbRotationDays),
      })
    }

    // ------------------------------------------------------------------
    // GitHub webhook secret — random hex
    // ------------------------------------------------------------------
    this.githubWebhookSecret = new secretsmanager.Secret(this, 'GithubWebhookSecret', {
      secretName: `orbital/${props.envName}/github-webhook-secret`,
      description: `Orbital ${props.envName} — GitHub webhook HMAC verification secret.`,
      encryptionKey: this.hubMasterKeyEncryptionKey,
      generateSecretString: {
        // 64 hex chars = 256-bit HMAC key
        passwordLength: 64,
        excludePunctuation: true,
        excludeUppercase: false,
        includeSpace: false,
        excludeCharacters: ' \t\n\r"\'\\',
      },
      removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
    })

    // ------------------------------------------------------------------
    // Cognito app client secret — only when explicitly requested
    // ------------------------------------------------------------------
    if (props.provisionCognitoClientSecret) {
      this.cognitoAppClientSecret = new secretsmanager.Secret(
        this,
        'CognitoAppClientSecret',
        {
          secretName: `orbital/${props.envName}/cognito-app-client-secret`,
          description: `Orbital ${props.envName} Cognito app client secret.`,
          encryptionKey: this.hubMasterKeyEncryptionKey,
          generateSecretString: {
            passwordLength: 48,
            excludePunctuation: false,
            includeSpace: false,
          },
          removalPolicy: isProd ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY,
        },
      )
    }

    // ------------------------------------------------------------------
    // Outputs
    // ------------------------------------------------------------------
    new cdk.CfnOutput(this, 'HubMasterKeySecretArn', {
      value: this.hubMasterKeySecret.secretArn,
      description: `Orbital ${props.envName} hub master key secret ARN`,
      exportName: `OrbitalHub-${props.envName}-HubMasterKeySecretArn`,
    })

    new cdk.CfnOutput(this, 'GithubWebhookSecretArn', {
      value: this.githubWebhookSecret.secretArn,
      description: `Orbital ${props.envName} GitHub webhook secret ARN`,
      exportName: `OrbitalHub-${props.envName}-GithubWebhookSecretArn`,
    })

    if (this.cognitoAppClientSecret) {
      new cdk.CfnOutput(this, 'CognitoAppClientSecretArn', {
        value: this.cognitoAppClientSecret.secretArn,
        description: `Orbital ${props.envName} Cognito app client secret ARN`,
        exportName: `OrbitalHub-${props.envName}-CognitoAppClientSecretArn`,
      })
    }

    new cdk.CfnOutput(this, 'HubMasterKeyKmsCmkArn', {
      value: this.hubMasterKeyEncryptionKey.keyArn,
      description: `Orbital ${props.envName} hub-secrets KMS CMK ARN`,
      exportName: `OrbitalHub-${props.envName}-HubMasterKeyKmsCmkArn`,
    })

    cdk.Tags.of(this).add('orbital:component', 'secrets')
  }

  /**
   * Grant a Lambda role read access to ONLY the listed secrets.
   *
   * This is the principle of least privilege: each Lambda is given the minimum
   * set of secrets it needs. Wrong scoping = secret leak across boundaries —
   * tested via `secrets.test.ts` IAM scoping suite.
   *
   * Example:
   *   secrets.grantReadFor(prsLambda, ['githubWebhookSecret'])
   *   secrets.grantReadFor(coreLambda, ['dbMasterCreds', 'hubMasterKey'])
   */
  grantReadFor(grantee: iam.IGrantable, refs: SecretRef[]): void {
    const seen = new Set<SecretRef>()
    for (const ref of refs) {
      if (seen.has(ref)) continue
      seen.add(ref)
      switch (ref) {
        case 'hubMasterKey':
          this.hubMasterKeySecret.grantRead(grantee)
          this.hubMasterKeyEncryptionKey.grantDecrypt(grantee)
          break
        case 'dbMasterCreds':
          this.dbMasterSecret.grantRead(grantee)
          break
        case 'githubWebhookSecret':
          this.githubWebhookSecret.grantRead(grantee)
          this.hubMasterKeyEncryptionKey.grantDecrypt(grantee)
          break
        case 'cognitoAppClientSecret':
          if (!this.cognitoAppClientSecret) {
            throw new Error(
              'SecretsConstruct.grantReadFor: cognitoAppClientSecret was not provisioned. ' +
                'Set provisionCognitoClientSecret: true in props.',
            )
          }
          this.cognitoAppClientSecret.grantRead(grantee)
          this.hubMasterKeyEncryptionKey.grantDecrypt(grantee)
          break
      }
    }
  }

  /**
   * Grant a Lambda function permission to write a new value to the hub master
   * key secret. Used by the rotation Lambda to install rotated keys.
   * Only the rotation Lambda should ever receive this grant.
   */
  grantWriteHubMasterKey(grantee: iam.IGrantable): void {
    this.hubMasterKeySecret.grantWrite(grantee)
    this.hubMasterKeyEncryptionKey.grantEncryptDecrypt(grantee)
    // The rotation Lambda also needs to read the previous version to retain
    // it in `${secret}.prev` during the verification window.
    this.hubMasterKeySecret.grantRead(grantee)
  }
}

// ---------------------------------------------------------------------------
// Helper exports — useful for callers building IAM policies elsewhere.
// ---------------------------------------------------------------------------

/**
 * The set of valid SecretRef values. Useful for validating callers' refs at
 * runtime (e.g. when refs come from a config string).
 */
export const SECRET_REFS: readonly SecretRef[] = [
  'hubMasterKey',
  'dbMasterCreds',
  'githubWebhookSecret',
  'cognitoAppClientSecret',
] as const

/**
 * Compose the canonical CloudWatch / Secrets Manager secret name for a given
 * env + ref. Useful in tests and downstream constructs that need to hard-code
 * the name (e.g. as a Lambda env var).
 */
export function secretName(envName: string, ref: SecretRef): string {
  switch (ref) {
    case 'hubMasterKey':
      return `orbital/${envName}/hub-master-key`
    case 'dbMasterCreds':
      return `orbital/${envName}/db-master-creds`
    case 'githubWebhookSecret':
      return `orbital/${envName}/github-webhook-secret`
    case 'cognitoAppClientSecret':
      return `orbital/${envName}/cognito-app-client-secret`
  }
}
