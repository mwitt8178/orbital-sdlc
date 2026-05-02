// [Engineer-Principal · Opus · run-round8-07-secrets-kms]
/**
 * onboarding/tenant-kms.ts
 *
 * Provision a per-tenant AWS KMS Customer Master Key (CMK) for a newly
 * onboarded tenant.
 *
 * Triggered by the onboarding Lambda when a new tenant signs up. The CMK
 * is used to:
 *   - Encrypt replay blobs in S3 (SSE-KMS, key per tenant)
 *   - Encrypt tenant-marked-sensitive PII fields in Aurora
 *
 * Cross-tenant isolation:
 *   - Each tenant has its OWN CMK with alias `alias/orbital-tenant-${tenantId}`
 *   - A Lambda processing tenant A's request resolves the CMK ARN from the
 *     `tenants` row keyed by tenant_id (set at request auth time via
 *     X-Orbital-Tenant-ID or Cognito token claim).
 *   - The S3 SSE-KMS request specifies that ARN. Tenant B's CMK ARN is never
 *     in scope.
 *   - Defence in depth: the CMK key policy below grants Encrypt/Decrypt only
 *     to the orbital hub Lambda role + the AWS root account; access is
 *     audited per call via CloudTrail.
 *
 * Tenant deletion (right-to-erasure):
 *   - `scheduleTenantCmkDeletion(tenantId, days=30)` schedules the CMK for
 *     deletion after the mandatory KMS waiting period.
 *   - Replay blobs encrypted with the CMK become permanently unreadable
 *     once deletion completes — that's the goal.
 */

import {
  KMSClient,
  CreateKeyCommand,
  CreateAliasCommand,
  DescribeKeyCommand,
  ScheduleKeyDeletionCommand,
  DeleteAliasCommand,
  KMSServiceException,
} from '@aws-sdk/client-kms'

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * The alias prefix used for every per-tenant CMK. Mirror of the constant in
 * `infra/lib/constructs/per-tenant-kms.ts`.
 */
export const TENANT_KEY_ALIAS_PREFIX = 'alias/orbital-tenant-'

export interface TenantCmkResult {
  /** AWS ARN of the CMK. Persist this on the tenants row. */
  keyArn: string
  /** Internal AWS KMS keyId (UUID portion of the ARN). */
  keyId: string
  /** Alias attached: `alias/orbital-tenant-${tenantId}`. */
  alias: string
}

export interface TenantKmsConfig {
  /** AWS region — defaults to AWS_REGION env. */
  region?: string
  /** Hub Lambda role ARN that will use the CMK at runtime (Encrypt/Decrypt). */
  hubLambdaRoleArn?: string
  /** Account ID of the deployment — used in key policy. */
  accountId?: string
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function aliasFor(tenantId: string): string {
  validateTenantId(tenantId)
  return `${TENANT_KEY_ALIAS_PREFIX}${tenantId}`
}

function validateTenantId(tenantId: string): void {
  // tenant_id is a UUID. Reject anything with characters outside the alias
  // namespace AWS allows so we never accidentally collide with another tenant.
  if (!/^[a-zA-Z0-9-]+$/.test(tenantId)) {
    throw new Error(
      `tenant-kms: invalid tenantId "${tenantId}" — must match [a-zA-Z0-9-]+`,
    )
  }
  if (tenantId.length < 8 || tenantId.length > 64) {
    throw new Error(
      `tenant-kms: invalid tenantId "${tenantId}" — must be 8–64 characters`,
    )
  }
}

function keyPolicyFor(opts: {
  accountId: string
  hubLambdaRoleArn?: string
  tenantId: string
}): string {
  // Default key policy: root account has full control + hub Lambda role can
  // Encrypt/Decrypt with this key. Tenant-side principals are NOT granted
  // direct access; all access flows through the hub.
  const statements: Array<Record<string, unknown>> = [
    {
      Sid: 'EnableRootAccountAdmin',
      Effect: 'Allow',
      Principal: { AWS: `arn:aws:iam::${opts.accountId}:root` },
      Action: 'kms:*',
      Resource: '*',
    },
  ]
  if (opts.hubLambdaRoleArn) {
    statements.push({
      Sid: 'AllowHubLambdaUsage',
      Effect: 'Allow',
      Principal: { AWS: opts.hubLambdaRoleArn },
      Action: [
        'kms:Encrypt',
        'kms:Decrypt',
        'kms:GenerateDataKey',
        'kms:GenerateDataKeyWithoutPlaintext',
        'kms:ReEncryptFrom',
        'kms:ReEncryptTo',
        'kms:DescribeKey',
      ],
      Resource: '*',
      Condition: {
        StringEquals: {
          // Restrict the hub Lambda's use of THIS specific CMK to the
          // intended tenant only — defense in depth against application bugs.
          'kms:EncryptionContext:tenantId': opts.tenantId,
        },
      },
    })
  }
  return JSON.stringify({ Version: '2012-10-17', Statement: statements })
}

function defaultClient(config?: TenantKmsConfig): KMSClient {
  const region = config?.region ?? process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION']
  return new KMSClient(region ? { region } : {})
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Provision a brand-new CMK for a tenant.
 *
 * Idempotency:
 *   - If the alias `alias/orbital-tenant-${tenantId}` already exists, the
 *     existing CMK ARN is returned (resolved via DescribeKey).
 *   - This makes the function safe to retry on failure.
 *
 * Side effects:
 *   - Creates a CMK in the configured region.
 *   - Creates the alias mapping the tenant to the CMK.
 *   - Tags the CMK with Owner=orbital, Env=<env>, TenantId=<tenantId>.
 *   - Emits a TenantCmkProvisioned event when called by the orchestrator
 *     (see onboardingLambda for the event emission).
 *
 * @param tenantId - the new tenant's id (UUID).
 * @param config - optional KMS client override + key-policy params.
 * @returns the ARN, key id, and alias.
 */
export async function createTenantCmk(
  tenantId: string,
  config?: TenantKmsConfig & { client?: KMSClient },
): Promise<TenantCmkResult> {
  validateTenantId(tenantId)
  const client = config?.client ?? defaultClient(config)
  const alias = aliasFor(tenantId)

  // 1. Idempotency check — if the alias already maps to a key, return it.
  try {
    const existing = await client.send(new DescribeKeyCommand({ KeyId: alias }))
    if (existing.KeyMetadata?.Arn && existing.KeyMetadata?.KeyId) {
      return {
        keyArn: existing.KeyMetadata.Arn,
        keyId: existing.KeyMetadata.KeyId,
        alias,
      }
    }
  } catch (err) {
    if (!isNotFoundError(err)) {
      throw err
    }
  }

  const accountId = config?.accountId ?? process.env['AWS_ACCOUNT_ID'] ?? ''
  const hubLambdaRoleArn = config?.hubLambdaRoleArn ?? process.env['ORBITAL_HUB_LAMBDA_ROLE_ARN']
  const env = process.env['ORBITAL_ENV'] ?? 'unknown'

  // 2. Create the CMK with tenant-scoped key policy.
  const created = await client.send(
    new CreateKeyCommand({
      Description: `Orbital per-tenant CMK for tenant ${tenantId}`,
      KeyUsage: 'ENCRYPT_DECRYPT',
      KeySpec: 'SYMMETRIC_DEFAULT',
      Origin: 'AWS_KMS',
      MultiRegion: false,
      // The KMS console shows tags; CloudTrail records them too.
      Tags: [
        { TagKey: 'Owner', TagValue: 'orbital' },
        { TagKey: 'Env', TagValue: env },
        { TagKey: 'TenantId', TagValue: tenantId },
      ],
      ...(accountId
        ? {
            Policy: keyPolicyFor({
              accountId,
              hubLambdaRoleArn,
              tenantId,
            }),
          }
        : {}),
    }),
  )

  const keyArn = created.KeyMetadata?.Arn
  const keyId = created.KeyMetadata?.KeyId
  if (!keyArn || !keyId) {
    throw new Error('createTenantCmk: KMS CreateKey returned no ARN/keyId')
  }

  // 3. Attach the alias.
  try {
    await client.send(
      new CreateAliasCommand({
        AliasName: alias,
        TargetKeyId: keyId,
      }),
    )
  } catch (err) {
    if (!isAlreadyExistsError(err)) {
      throw err
    }
    // Alias already exists from a concurrent create; resolve.
    const resolved = await client.send(new DescribeKeyCommand({ KeyId: alias }))
    if (resolved.KeyMetadata?.Arn && resolved.KeyMetadata?.KeyId) {
      return {
        keyArn: resolved.KeyMetadata.Arn,
        keyId: resolved.KeyMetadata.KeyId,
        alias,
      }
    }
    throw err
  }

  return { keyArn, keyId, alias }
}

/**
 * Resolve a tenant's CMK ARN by alias. Returns null if the tenant has no CMK.
 *
 * Used by the replay store + sensitive-field encrypter to find the correct key
 * for a given tenant request.
 */
export async function resolveTenantCmk(
  tenantId: string,
  config?: TenantKmsConfig & { client?: KMSClient },
): Promise<TenantCmkResult | null> {
  validateTenantId(tenantId)
  const client = config?.client ?? defaultClient(config)
  const alias = aliasFor(tenantId)
  try {
    const resp = await client.send(new DescribeKeyCommand({ KeyId: alias }))
    if (!resp.KeyMetadata?.Arn || !resp.KeyMetadata?.KeyId) return null
    return { keyArn: resp.KeyMetadata.Arn, keyId: resp.KeyMetadata.KeyId, alias }
  } catch (err) {
    if (isNotFoundError(err)) return null
    throw err
  }
}

/**
 * Schedule deletion of a tenant's CMK. The CMK enters a mandatory waiting
 * period (default 30 days) before deletion. Replay blobs encrypted with the
 * CMK become unreadable once deletion completes — this is the right-to-erasure
 * path.
 */
export async function scheduleTenantCmkDeletion(
  tenantId: string,
  pendingWindowDays = 30,
  config?: TenantKmsConfig & { client?: KMSClient },
): Promise<void> {
  validateTenantId(tenantId)
  if (pendingWindowDays < 7 || pendingWindowDays > 30) {
    // KMS allows 7–30 days; default 30. Reject out-of-range values explicitly.
    throw new Error(
      `scheduleTenantCmkDeletion: pendingWindowDays must be 7–30 (got ${pendingWindowDays})`,
    )
  }
  const client = config?.client ?? defaultClient(config)
  const alias = aliasFor(tenantId)

  const meta = await client.send(new DescribeKeyCommand({ KeyId: alias }))
  const keyId = meta.KeyMetadata?.KeyId
  if (!keyId) {
    throw new Error(`scheduleTenantCmkDeletion: no key found for tenantId=${tenantId}`)
  }

  // Delete alias first so the namespace is freed for re-use after the waiting
  // period (or for resurrection-by-recreate if the deletion is cancelled).
  await client.send(new DeleteAliasCommand({ AliasName: alias }))
  await client.send(
    new ScheduleKeyDeletionCommand({ KeyId: keyId, PendingWindowInDays: pendingWindowDays }),
  )
}

// ---------------------------------------------------------------------------
// SDK error type guards
// ---------------------------------------------------------------------------

function isNotFoundError(err: unknown): boolean {
  if (err instanceof KMSServiceException) {
    return err.name === 'NotFoundException' || err.$metadata?.httpStatusCode === 404
  }
  if (err instanceof Error) {
    return err.name === 'NotFoundException'
  }
  return false
}

function isAlreadyExistsError(err: unknown): boolean {
  if (err instanceof KMSServiceException) {
    return err.name === 'AlreadyExistsException' || err.$metadata?.httpStatusCode === 409
  }
  if (err instanceof Error) {
    return err.name === 'AlreadyExistsException'
  }
  return false
}
