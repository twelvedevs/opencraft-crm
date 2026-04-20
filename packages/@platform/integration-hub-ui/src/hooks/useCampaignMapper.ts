import { useState, useEffect, useCallback } from 'react'
import type { IntegrationHubApiClient } from '../api/IntegrationHubApiClient.js'
import type { CampaignSummary } from '../types.js'

export interface UseCampaignMapperResult {
  campaigns: CampaignSummary[]
  mappings: Record<string, string>  // campaign_id → location_id
  loading: boolean
  saving: boolean
  error: string | null
  setMapping: (campaignId: string, locationId: string | null) => void
  save: () => Promise<void>
}

export function useCampaignMapper(
  client: IntegrationHubApiClient,
  accountId: string | null,
): UseCampaignMapperResult {
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>([])
  const [mappings, setMappings] = useState<Record<string, string>>({})
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!accountId) {
      setCampaigns([])
      setMappings({})
      return
    }
    // Guard against stale responses when accountId changes mid-flight.
    let cancelled = false
    setLoading(true)
    setError(null)
    client.getCampaigns(accountId).then(data => {
      if (cancelled) return
      setCampaigns(data)
      const m: Record<string, string> = {}
      for (const c of data) {
        if (c.location_id) m[c.campaign_id] = c.location_id
      }
      setMappings(m)
    }).catch(err => {
      if (cancelled) return
      setError(err instanceof Error ? err.message : 'Failed to load campaigns')
    }).finally(() => {
      if (!cancelled) setLoading(false)
    })
    return () => { cancelled = true }
  }, [client, accountId])

  const setMapping = useCallback((campaignId: string, locationId: string | null) => {
    setMappings(prev => {
      if (!locationId) {
        const next = { ...prev }
        delete next[campaignId]
        return next
      }
      return { ...prev, [campaignId]: locationId }
    })
  }, [])

  const save = useCallback(async () => {
    if (!accountId) return
    setSaving(true)
    setError(null)
    try {
      const mapped = Object.entries(mappings).map(([campaign_id, location_id]) => ({
        campaign_id,
        location_id,
      }))
      await client.saveMappings(accountId, mapped)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to save mappings')
    } finally {
      setSaving(false)
    }
  }, [client, accountId, mappings])

  return { campaigns, mappings, loading, saving, error, setMapping, save }
}
