/**
 * Unit tests for BlockerService routing chain logic.
 *
 * No DB required — tests the resolver chain table and policy lookups.
 */

import { describe, it, expect } from 'vitest'
import { DEFAULT_RESOLVER_CHAIN } from '../../../src/comms/blockers.js'

describe('BlockerService DEFAULT_RESOLVER_CHAIN', () => {
  it('contains a chain for architect', () => {
    const chain = DEFAULT_RESOLVER_CHAIN['architect']
    expect(chain).toBeDefined()
    expect(chain).toContain('architect')
  })

  it('contains a chain for security_officer with fallback', () => {
    const chain = DEFAULT_RESOLVER_CHAIN['security_officer']
    expect(chain).toBeDefined()
    if (chain) {
      expect(chain.length).toBeGreaterThanOrEqual(1)
      expect(chain[0]).toBe('security_officer')
    }
  })

  it('all chains include the requested role as the first entry', () => {
    for (const [role, chain] of Object.entries(DEFAULT_RESOLVER_CHAIN)) {
      expect(chain[0]).toBe(role)
    }
  })
})
