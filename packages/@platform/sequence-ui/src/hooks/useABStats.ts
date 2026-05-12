import { useState, useEffect } from 'react'
import type { SequenceApiClient } from '../api/SequenceApiClient.js'
import type { SequenceStats } from '../types.js'

export interface UseABStatsResult {
  stats: SequenceStats | null
  loading: boolean
  error: string | null
}

export function useABStats(
  client: Pick<SequenceApiClient, 'getStats'>,
  sequenceId: string,
): UseABStatsResult {
  const [stats, setStats] = useState<SequenceStats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    client
      .getStats(sequenceId)
      .then((s) => {
        if (!cancelled) {
          setStats(s)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load stats')
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, sequenceId])

  return { stats, loading, error }
}
