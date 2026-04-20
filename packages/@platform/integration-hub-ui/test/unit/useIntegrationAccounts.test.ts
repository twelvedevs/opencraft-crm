import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useIntegrationAccounts } from '../../src/hooks/useIntegrationAccounts.js'
import type { IntegrationHubApiClient } from '../../src/api/IntegrationHubApiClient.js'

const ACCOUNT_1 = {
  id: 'acc-1',
  platform: 'google_ads' as const,
  account_id: 'g-123',
  account_name: 'My Google Ads',
  status: 'active' as const,
  last_error: null,
  last_polled_at: null,
}

const ACCOUNT_2 = {
  id: 'acc-2',
  platform: 'facebook_ads' as const,
  account_id: 'f-456',
  account_name: 'My Meta',
  status: 'error' as const,
  last_error: 'Token expired',
  last_polled_at: null,
}

function makeClient(overrides: Partial<InstanceType<typeof IntegrationHubApiClient>> = {}) {
  return {
    listAccounts: vi.fn().mockResolvedValue([ACCOUNT_1, ACCOUNT_2]),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as InstanceType<typeof IntegrationHubApiClient>
}

describe('useIntegrationAccounts', () => {
  it('loads accounts on mount and auto-selects first', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useIntegrationAccounts(client))

    expect(result.current.loading).toBe(true)
    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.accounts).toEqual([ACCOUNT_1, ACCOUNT_2])
    expect(result.current.selectedId).toBe('acc-1')
    expect(result.current.error).toBeNull()
  })

  it('sets error when load fails', async () => {
    const client = makeClient({
      listAccounts: vi.fn().mockRejectedValue(new Error('Network error')),
    })
    const { result } = renderHook(() => useIntegrationAccounts(client))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('Network error')
    expect(result.current.accounts).toEqual([])
  })

  it('selectAccount updates selectedId', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useIntegrationAccounts(client))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.selectAccount('acc-2'))
    expect(result.current.selectedId).toBe('acc-2')
  })

  it('disconnect: calls deleteAccount, clears selection if current, reloads', async () => {
    const listAccounts = vi.fn()
      .mockResolvedValueOnce([ACCOUNT_1, ACCOUNT_2])  // initial load
      .mockResolvedValueOnce([ACCOUNT_2])              // after disconnect
    const deleteAccount = vi.fn().mockResolvedValue(undefined)
    const client = makeClient({ listAccounts, deleteAccount })

    const { result } = renderHook(() => useIntegrationAccounts(client))
    await waitFor(() => expect(result.current.loading).toBe(false))
    // selectedId is acc-1 (auto-selected)

    await act(async () => { await result.current.disconnect('acc-1') })

    expect(deleteAccount).toHaveBeenCalledWith('acc-1')
    expect(result.current.selectedId).toBeNull()
    expect(result.current.accounts).toEqual([ACCOUNT_2])
  })

  it('disconnect: preserves selection when disconnecting a different account', async () => {
    const listAccounts = vi.fn()
      .mockResolvedValueOnce([ACCOUNT_1, ACCOUNT_2])
      .mockResolvedValueOnce([ACCOUNT_1])
    const client = makeClient({ listAccounts, deleteAccount: vi.fn().mockResolvedValue(undefined) })

    const { result } = renderHook(() => useIntegrationAccounts(client))
    await waitFor(() => expect(result.current.loading).toBe(false))
    // selectedId is acc-1

    await act(async () => { await result.current.disconnect('acc-2') })
    expect(result.current.selectedId).toBe('acc-1')
  })
})
