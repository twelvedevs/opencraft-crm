import { describe, it, expect, vi } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { useABStats } from '../../src/hooks/useABStats.js'
import type { SequenceApiClient } from '../../src/api/SequenceApiClient.js'
import type { SequenceStats } from '../../src/types.js'

function makeClient(stats: SequenceStats): Pick<SequenceApiClient, 'getStats'> {
  return { getStats: vi.fn().mockResolvedValue(stats) }
}

const statsWithAB: SequenceStats = {
  sequence_id: 'seq-1',
  total_enrollments: 200,
  completed_count: 120,
  unenrolled_count: 60,
  failed_count: 5,
  active_count: 15,
  completion_rate: 0.6,
  unenrollment_rate: 0.3,
  ab: {
    A: { enrollments: 100, completions: 62, completion_rate: 0.62, conversion_count: 24, conversion_rate: 0.24 },
    B: { enrollments: 100, completions: 58, completion_rate: 0.58, conversion_count: 17, conversion_rate: 0.17 },
    winner: 'A',
    significant: true,
    p_value: 0.031,
  },
}

const statsNoAB: SequenceStats = { ...statsWithAB, ab: null }

describe('useABStats', () => {
  it('starts in loading state', () => {
    const client = makeClient(statsWithAB)
    const { result } = renderHook(() =>
      useABStats(client as SequenceApiClient, 'seq-1'),
    )
    expect(result.current.loading).toBe(true)
    expect(result.current.stats).toBeNull()
  })

  it('loads stats and sets loading false', async () => {
    const client = makeClient(statsWithAB)
    const { result } = renderHook(() =>
      useABStats(client as SequenceApiClient, 'seq-1'),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.stats).toEqual(statsWithAB)
    expect(result.current.error).toBeNull()
  })

  it('stats.ab is null when sequence has no A/B test', async () => {
    const client = makeClient(statsNoAB)
    const { result } = renderHook(() =>
      useABStats(client as SequenceApiClient, 'seq-1'),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.stats?.ab).toBeNull()
  })

  it('sets error on API failure', async () => {
    const client = {
      getStats: vi.fn().mockRejectedValue(new Error('network error')),
    }
    const { result } = renderHook(() =>
      useABStats(client as unknown as SequenceApiClient, 'seq-1'),
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('network error')
    expect(result.current.stats).toBeNull()
  })
})
