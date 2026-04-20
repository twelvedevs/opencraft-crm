import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useBackfillStatus } from '../../src/hooks/useBackfillStatus.js'
import type { IntegrationHubApiClient } from '../../src/api/IntegrationHubApiClient.js'

const JOB = {
  job_id: 'job-1',
  status: 'active' as const,
  from_date: '2026-01-01',
  to_date: '2026-03-31',
  progress: { chunks_done: 0, chunks_total: 13 },
}

function makeClient(overrides: Partial<InstanceType<typeof IntegrationHubApiClient>> = {}) {
  return {
    triggerBackfill: vi.fn().mockResolvedValue({ job_id: 'job-1' }),
    getBackfillStatus: vi.fn().mockResolvedValue(JOB),
    ...overrides,
  } as unknown as InstanceType<typeof IntegrationHubApiClient>
}

describe('useBackfillStatus', () => {
  it('starts with no job', () => {
    const client = makeClient()
    const { result } = renderHook(() => useBackfillStatus(client, 'acc-1'))
    expect(result.current.latestJob).toBeNull()
    expect(result.current.triggering).toBe(false)
  })

  it('resets latestJob when accountId changes', async () => {
    const client = makeClient()
    const { result, rerender } = renderHook(
      ({ id }) => useBackfillStatus(client, id),
      { initialProps: { id: 'acc-1' as string | null } },
    )

    // trigger a backfill to set latestJob
    await act(async () => { await result.current.triggerBackfill('2026-01-01', '2026-03-31') })
    expect(result.current.latestJob).toEqual(JOB)

    rerender({ id: 'acc-2' })
    expect(result.current.latestJob).toBeNull()
  })

  it('triggerBackfill: calls triggerBackfill then getBackfillStatus and sets latestJob', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useBackfillStatus(client, 'acc-1'))

    await act(async () => {
      await result.current.triggerBackfill('2026-01-01', '2026-03-31')
    })

    expect(client.triggerBackfill).toHaveBeenCalledWith('acc-1', '2026-01-01', '2026-03-31')
    expect(client.getBackfillStatus).toHaveBeenCalledWith('acc-1', 'job-1')
    expect(result.current.latestJob).toEqual(JOB)
    expect(result.current.triggering).toBe(false)
  })

  it('does nothing when accountId is null', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useBackfillStatus(client, null))

    await act(async () => {
      await result.current.triggerBackfill('2026-01-01', '2026-03-31')
    })

    expect(client.triggerBackfill).not.toHaveBeenCalled()
    expect(result.current.latestJob).toBeNull()
  })
})
