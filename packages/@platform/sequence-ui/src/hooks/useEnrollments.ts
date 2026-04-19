import { useState, useEffect, useCallback } from 'react'
import type { SequenceApiClient } from '../api/SequenceApiClient.js'
import type { Enrollment, EnrollmentFilters } from '../types.js'

export interface UseEnrollmentsResult {
  enrollments: Enrollment[]
  loading: boolean
  error: string | null
  hasMore: boolean
  loadMore: () => void
  filters: EnrollmentFilters
  setFilters: (f: EnrollmentFilters) => void
}

export function useEnrollments(
  client: SequenceApiClient,
  sequenceId: string,
): UseEnrollmentsResult {
  const [enrollments, setEnrollments] = useState<Enrollment[]>([])
  const [cursor, setCursor] = useState<string | undefined>(undefined)
  const [hasMore, setHasMore] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [filters, setFiltersState] = useState<EnrollmentFilters>({})

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError(null)
    setEnrollments([])
    setCursor(undefined)
    client
      .listEnrollments(sequenceId, { ...filters, limit: 50 })
      .then((res) => {
        if (!cancelled) {
          setEnrollments(res.data)
          setCursor(res.nextCursor)
          setHasMore(!!res.nextCursor)
          setLoading(false)
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : 'Failed to load enrollments')
          setLoading(false)
        }
      })
    return () => {
      cancelled = true
    }
  }, [client, sequenceId, filters])

  const loadMore = useCallback(() => {
    if (!cursor || loading) return
    setLoading(true)
    client
      .listEnrollments(sequenceId, { ...filters, cursor, limit: 50 })
      .then((res) => {
        setEnrollments((prev) => [...prev, ...res.data])
        setCursor(res.nextCursor)
        setHasMore(!!res.nextCursor)
        setLoading(false)
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : 'Failed to load more')
        setLoading(false)
      })
  }, [client, sequenceId, filters, cursor, loading])

  const setFilters = useCallback((f: EnrollmentFilters) => setFiltersState(f), [])

  return { enrollments, loading, error, hasMore, loadMore, filters, setFilters }
}
