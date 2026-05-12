import { useState, useEffect, useCallback } from 'react'
import type { IntegrationHubApiClient } from '../api/IntegrationHubApiClient.js'
import type { BackfillJob } from '../types.js'

export interface UseBackfillStatusResult {
  latestJob: BackfillJob | null
  triggering: boolean
  /**
   * Starts a backfill and stores the resulting job status. Rejections from the
   * API propagate to the caller — unlike sibling hooks, errors are not stored
   * in hook state because the action is user-initiated and the caller owns the
   * button that triggered it. `triggering` always resets via `finally`.
   */
  triggerBackfill: (from: string, to: string) => Promise<void>
}

export function useBackfillStatus(
  client: IntegrationHubApiClient,
  accountId: string | null,
): UseBackfillStatusResult {
  const [latestJob, setLatestJob] = useState<BackfillJob | null>(null)
  const [triggering, setTriggering] = useState(false)

  useEffect(() => {
    setLatestJob(null)
  }, [accountId])

  const triggerBackfill = useCallback(async (from: string, to: string) => {
    if (!accountId) return
    setTriggering(true)
    try {
      const { job_id } = await client.triggerBackfill(accountId, from, to)
      const job = await client.getBackfillStatus(accountId, job_id)
      setLatestJob(job)
    } finally {
      setTriggering(false)
    }
  }, [client, accountId])

  return { latestJob, triggering, triggerBackfill }
}
