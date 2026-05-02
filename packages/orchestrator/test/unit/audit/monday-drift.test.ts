/**
 * monday-drift.test.ts — Unit tests for createMondayDriftCheck.
 *
 * Gap O7: Monday drift callback wired into DriftReconciler.
 */

import { describe, it, expect, vi } from 'vitest'
import { createMondayDriftCheck } from '../../../src/audit/monday-drift.js'
import type { MondaySyncService } from '../../../src/backlog/monday-sync.js'

// ---------------------------------------------------------------------------
// Mock MondaySyncService
// ---------------------------------------------------------------------------

function makeMockSyncService(
  result: Awaited<ReturnType<MondaySyncService['reconcile']>>,
): MondaySyncService {
  return {
    reconcile: vi.fn(async () => result),
    onStoryCreated: vi.fn(),
    onStoryStatusChanged: vi.fn(),
    handleWebhookPayload: vi.fn(),
    startScheduledReconcile: vi.fn(),
    stopScheduledReconcile: vi.fn(),
  } as unknown as MondaySyncService
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('createMondayDriftCheck', () => {
  it('returns a no-op callback when boardId is undefined', async () => {
    const syncService = makeMockSyncService({ pulledCount: 0, driftCount: 0, boardId: 'board-1' })
    const check = createMondayDriftCheck({ syncService, boardId: undefined })
    const result = await check()
    expect(result).toEqual([])
    expect(syncService.reconcile).not.toHaveBeenCalled()
  })

  it('returns a no-op callback when boardId is empty string', async () => {
    const syncService = makeMockSyncService({ pulledCount: 0, driftCount: 0, boardId: '' })
    const check = createMondayDriftCheck({ syncService, boardId: '' })
    const result = await check()
    expect(result).toEqual([])
    expect(syncService.reconcile).not.toHaveBeenCalled()
  })

  it('returns empty array when reconcile finds no drift', async () => {
    const syncService = makeMockSyncService({ pulledCount: 42, driftCount: 0, boardId: 'board-123' })
    const check = createMondayDriftCheck({ syncService, boardId: 'board-123' })
    const result = await check()
    expect(result).toEqual([])
    expect(syncService.reconcile).toHaveBeenCalledWith('board-123')
  })

  it('returns DriftDetail[] when reconcile finds drift', async () => {
    const syncService = makeMockSyncService({ pulledCount: 10, driftCount: 3, boardId: 'board-456' })
    const check = createMondayDriftCheck({ syncService, boardId: 'board-456' })
    const result = await check()

    expect(result).toHaveLength(1)
    expect(result[0]?.source).toBe('monday')
    expect(result[0]?.drift_kind).toBe('monday_status_without_event')
    expect(result[0]?.severity).toBe('warning')
    expect((result[0]?.observed as Record<string, unknown>)['drift_count']).toBe(3)
    expect((result[0]?.observed as Record<string, unknown>)['board_id']).toBe('board-456')
  })

  it('returns empty array (does not throw) when reconcile fails', async () => {
    const syncService = {
      reconcile: vi.fn().mockRejectedValue(new Error('Monday API timeout')),
    } as unknown as MondaySyncService

    const check = createMondayDriftCheck({ syncService, boardId: 'board-789' })
    const result = await check()
    expect(result).toEqual([])
  })

  it('calls reconcile with the configured boardId', async () => {
    const syncService = makeMockSyncService({ pulledCount: 5, driftCount: 0, boardId: 'my-board' })
    const check = createMondayDriftCheck({ syncService, boardId: 'my-board' })
    await check()
    expect(syncService.reconcile).toHaveBeenCalledWith('my-board')
  })
})
