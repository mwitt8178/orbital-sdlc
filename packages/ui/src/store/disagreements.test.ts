/**
 * Tests for the disagreements store.
 *
 * Pure store logic — no DOM/React required.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { useDisagreementsStore } from './disagreements.js'

function resetStore() {
  useDisagreementsStore.setState({ active: [] })
}

describe('useDisagreementsStore', () => {
  beforeEach(() => {
    resetStore()
  })

  it('starts empty', () => {
    expect(useDisagreementsStore.getState().active).toEqual([])
  })

  it('applyDisagreementRaised adds a new disagreement', () => {
    useDisagreementsStore.getState().applyDisagreementRaised({
      disagreement_id: 'd-001',
      topic: 'Auth approach',
      channel_id: 'ch-abc',
      occurred_at: '2026-01-01T00:00:00Z',
    })
    const { active } = useDisagreementsStore.getState()
    expect(active).toHaveLength(1)
    expect(active[0]!.disagreementId).toBe('d-001')
    expect(active[0]!.topic).toBe('Auth approach')
    expect(active[0]!.channelId).toBe('ch-abc')
    expect(active[0]!.status).toBe('active')
    expect(active[0]!.tieBreakerPersona).toBeNull()
  })

  it('applyDisagreementRaised is idempotent on duplicate id', () => {
    const payload = {
      disagreement_id: 'd-001',
      topic: 'Auth approach',
      channel_id: 'ch-abc',
    }
    useDisagreementsStore.getState().applyDisagreementRaised(payload)
    useDisagreementsStore.getState().applyDisagreementRaised(payload)
    expect(useDisagreementsStore.getState().active).toHaveLength(1)
  })

  it('applyTieBreakerDecided updates status and tieBreakerPersona', () => {
    useDisagreementsStore.getState().applyDisagreementRaised({
      disagreement_id: 'd-001',
      topic: 'Auth approach',
      channel_id: 'ch-abc',
    })
    useDisagreementsStore.getState().applyTieBreakerDecided({
      disagreement_id: 'd-001',
      tie_breaker_persona: 'arch-lead',
      occurred_at: '2026-01-01T01:00:00Z',
    })
    const d = useDisagreementsStore.getState().active[0]!
    expect(d.status).toBe('decided')
    expect(d.tieBreakerPersona).toBe('arch-lead')
    expect(d.decidedAt).toBe('2026-01-01T01:00:00Z')
  })

  it('applyADRPublished resolves the disagreement and stores adrId', () => {
    useDisagreementsStore.getState().applyDisagreementRaised({
      disagreement_id: 'd-001',
      topic: 'Auth approach',
      channel_id: 'ch-abc',
    })
    useDisagreementsStore.getState().applyADRPublished({
      disagreement_id: 'd-001',
      adr_id: 'adr-42',
      occurred_at: '2026-01-01T02:00:00Z',
    })
    const d = useDisagreementsStore.getState().active[0]!
    expect(d.status).toBe('resolved')
    expect(d.adrId).toBe('adr-42')
    expect(d.resolvedAt).toBe('2026-01-01T02:00:00Z')
  })

  it('applyTieBreakerDecided is a no-op for unknown id', () => {
    useDisagreementsStore.getState().applyTieBreakerDecided({
      disagreement_id: 'does-not-exist',
      tie_breaker_persona: 'arch-lead',
    })
    // Should not throw, just no-op
    expect(useDisagreementsStore.getState().active).toHaveLength(0)
  })

  it('multiple disagreements coexist', () => {
    useDisagreementsStore.getState().applyDisagreementRaised({
      disagreement_id: 'd-001',
      topic: 'Topic A',
      channel_id: 'ch-1',
    })
    useDisagreementsStore.getState().applyDisagreementRaised({
      disagreement_id: 'd-002',
      topic: 'Topic B',
      channel_id: 'ch-2',
    })
    expect(useDisagreementsStore.getState().active).toHaveLength(2)
  })
})
