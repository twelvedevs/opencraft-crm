import { useState, useEffect, useCallback, useRef } from 'react'
import type { IntegrationHubApiClient } from '../api/IntegrationHubApiClient.js'
import type { IntegrationAccount } from '../types.js'

export interface UseIntegrationAccountsResult {
  accounts: IntegrationAccount[]
  selectedId: string | null
  loading: boolean
  error: string | null
  selectAccount: (id: string) => void
  disconnect: (id: string) => Promise<void>
  reload: () => Promise<void>
}

export function useIntegrationAccounts(client: IntegrationHubApiClient): UseIntegrationAccountsResult {
  const [accounts, setAccounts] = useState<IntegrationAccount[]>([])
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  // When true, the next load() call will not auto-select the first account
  const suppressAutoSelectRef = useRef(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const data = await client.listAccounts()
      setAccounts(data)
      const suppressAutoSelect = suppressAutoSelectRef.current
      suppressAutoSelectRef.current = false
      setSelectedId(prev => {
        if (suppressAutoSelect) {
          // Keep null (or existing valid selection); don't auto-select
          if (prev !== null && data.some(a => a.id === prev)) return prev
          return null
        }
        if (prev !== null && data.some(a => a.id === prev)) return prev
        return data.length > 0 ? data[0]!.id : null
      })
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load accounts')
      setAccounts([])
    } finally {
      setLoading(false)
    }
  }, [client])

  useEffect(() => { void load() }, [load])

  const selectAccount = useCallback((id: string) => {
    setSelectedId(id)
  }, [])

  const disconnect = useCallback(async (id: string) => {
    await client.deleteAccount(id)
    setSelectedId(prev => (prev === id ? null : prev))
    suppressAutoSelectRef.current = true
    await load()
  }, [client, load])

  return { accounts, selectedId, loading, error, selectAccount, disconnect, reload: load }
}
