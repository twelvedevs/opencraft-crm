import { useState, useEffect, useCallback } from 'react'
import type { SequenceApiClient } from '../api/SequenceApiClient.js'
import type { SequenceSummary } from '../types.js'

export interface UseSequenceListResult {
  sequences: SequenceSummary[]
  loading: boolean
  error: string | null
  activate: (id: string) => Promise<void>
  disable: (id: string) => Promise<void>
  refresh: () => void
}

export function useSequenceList(client: SequenceApiClient): UseSequenceListResult {
  const [sequences, setSequences] = useState<SequenceSummary[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [tick, setTick] = useState(0)

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    client
      .listSequences()
      .then((res) => {
        if (!cancelled) {
          setSequences(res.data)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load sequences')
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, tick])

  const refresh = useCallback(() => setTick((t) => t + 1), [])

  const activate = useCallback(
    async (id: string) => {
      await client.activate(id)
      refresh()
    },
    [client, refresh],
  )

  const disable = useCallback(
    async (id: string) => {
      await client.disable(id)
      refresh()
    },
    [client, refresh],
  )

  return { sequences, loading, error, activate, disable, refresh }
}
