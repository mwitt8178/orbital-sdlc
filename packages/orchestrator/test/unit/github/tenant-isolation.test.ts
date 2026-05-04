/**
 * Unit test: tenant isolation for github.listRepos and github.getInstallationToken.
 *
 * A tenant must not be able to read repos or tokens for an installation_id
 * owned by a different tenant. The check is: does installation_id exist in
 * github_installations with the caller's tenant_id?
 *
 * [Engineer-Sr · Sonnet · run-github-app-install]
 */

import { describe, it, expect, vi } from 'vitest'
import { assertInstallationBelongsToTenant } from '../../../src/github/install-repos.js'

describe('assertInstallationBelongsToTenant', () => {
  it('resolves when installation belongs to the tenant', async () => {
    const mockQuery = vi.fn().mockResolvedValue([{ installationId: 42 }])
    await expect(
      assertInstallationBelongsToTenant({
        installationId: 42,
        tenantId: 'tenant-a',
        queryInstallations: mockQuery,
      }),
    ).resolves.toBeUndefined()
    expect(mockQuery).toHaveBeenCalledWith({ installationId: 42, tenantId: 'tenant-a' })
  })

  it('throws FORBIDDEN when installation belongs to a different tenant', async () => {
    const mockQuery = vi.fn().mockResolvedValue([]) // empty = not found for this tenant
    await expect(
      assertInstallationBelongsToTenant({
        installationId: 99,
        tenantId: 'tenant-a',
        queryInstallations: mockQuery,
      }),
    ).rejects.toThrow(/FORBIDDEN|installation not found/i)
  })

  it('throws FORBIDDEN when installation does not exist at all', async () => {
    const mockQuery = vi.fn().mockResolvedValue([])
    await expect(
      assertInstallationBelongsToTenant({
        installationId: 404,
        tenantId: 'any-tenant',
        queryInstallations: mockQuery,
      }),
    ).rejects.toThrow(/FORBIDDEN|installation not found/i)
  })
})
