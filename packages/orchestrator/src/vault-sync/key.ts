/**
 * vault-sync/key.ts — Tenant-safe S3 key + relative-path builder.
 *
 * [Engineer-Principal · Opus · run-obsidian-vault-sync]
 *
 * Every S3 access in this package MUST go through these helpers. They are the
 * single chokepoint that guarantees a tenant prefix is always applied. A unit
 * test asserts the package never calls `s3.PutObject` / `s3.GetObject` with a
 * key that doesn't start with `${tenantId}/`.
 */

import type { VaultEntityType } from './types.js'

const SLUG_RE = /[^a-z0-9]+/g

/**
 * kebabify — slug suitable for a file basename. Trims to 80 chars max so
 * pathological titles (rare) don't blow past S3 key limits.
 */
export function kebabify(input: string): string {
  const trimmed = input.toLowerCase().trim().replace(SLUG_RE, '-').replace(/^-+|-+$/g, '')
  if (trimmed.length === 0) return 'untitled'
  return trimmed.slice(0, 80)
}

/** Folder under the project root for each entity type. */
const FOLDER: Record<VaultEntityType, string> = {
  vision: 'visions',
  epic: 'epics',
  story: 'stories',
  ac: 'acs',
  retro: 'retros',
  memory: 'memory',
}

/**
 * vaultRelativePath — path inside the vault, NOT including the tenant prefix.
 * Used both for the S3 key suffix and for the local plugin write path.
 *
 * @example
 *   vaultRelativePath({ projectSlug: 'orbital', type: 'story', basename: 'login-flow' })
 *   // → 'projects/orbital/stories/login-flow.md'
 */
export function vaultRelativePath(input: {
  projectSlug: string
  type: VaultEntityType
  basename: string
}): string {
  const folder = FOLDER[input.type]
  const slug = kebabify(input.projectSlug)
  const file = kebabify(input.basename)
  return `projects/${slug}/${folder}/${file}.md`
}

/**
 * vaultS3Key — fully qualified S3 key including tenant prefix.
 * Throws if tenantId is empty / not a UUID-shaped string.
 *
 * @throws Error if tenantId is missing or malformed
 */
export function vaultS3Key(input: {
  tenantId: string
  projectSlug: string
  type: VaultEntityType
  basename: string
}): string {
  assertTenantId(input.tenantId)
  const rel = vaultRelativePath({
    projectSlug: input.projectSlug,
    type: input.type,
    basename: input.basename,
  })
  return `${input.tenantId}/${rel}`
}

/**
 * vaultS3Prefix — prefix for ListObjects calls scoped to a tenant + project.
 * Always ends with '/'. Always starts with the tenant id.
 */
export function vaultS3Prefix(input: { tenantId: string; projectSlug?: string }): string {
  assertTenantId(input.tenantId)
  if (input.projectSlug === undefined || input.projectSlug.length === 0) {
    return `${input.tenantId}/`
  }
  return `${input.tenantId}/projects/${kebabify(input.projectSlug)}/`
}

/**
 * vaultManifestKey — well-known per-project manifest the plugin reads to
 * decide what to fetch.
 */
export function vaultManifestKey(input: { tenantId: string; projectSlug: string }): string {
  assertTenantId(input.tenantId)
  return `${input.tenantId}/projects/${kebabify(input.projectSlug)}/.orbital/manifest.json`
}

const TENANT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function assertTenantId(tenantId: string): void {
  if (typeof tenantId !== 'string' || tenantId.length === 0) {
    throw new Error('vault-sync: tenantId is required')
  }
  if (!TENANT_ID_RE.test(tenantId)) {
    throw new Error(`vault-sync: tenantId must be a UUID, got '${tenantId}'`)
  }
}
