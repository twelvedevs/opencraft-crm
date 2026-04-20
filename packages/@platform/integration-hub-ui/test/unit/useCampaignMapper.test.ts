import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useCampaignMapper } from '../../src/hooks/useCampaignMapper.js'
import type { IntegrationHubApiClient } from '../../src/api/IntegrationHubApiClient.js'

const CAMPAIGNS = [
  { campaign_id: 'c1', campaign_name: 'Spring', location_id: 'loc-1' },
  { campaign_id: 'c2', campaign_name: 'Summer', location_id: null },
]

function makeClient(overrides: Partial<InstanceType<typeof IntegrationHubApiClient>> = {}) {
  return {
    getCampaigns: vi.fn().mockResolvedValue(CAMPAIGNS),
    saveMappings: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  } as unknown as InstanceType<typeof IntegrationHubApiClient>
}

describe('useCampaignMapper', () => {
  it('loads campaigns when accountId is set, pre-fills mapped location_ids', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useCampaignMapper(client, 'acc-1'))

    await waitFor(() => expect(result.current.loading).toBe(false))

    expect(result.current.campaigns).toEqual(CAMPAIGNS)
    expect(result.current.mappings).toEqual({ c1: 'loc-1' })  // c2 is null, excluded
  })

  it('resets when accountId changes to null', async () => {
    const client = makeClient()
    const { result, rerender } = renderHook(
      ({ id }) => useCampaignMapper(client, id),
      { initialProps: { id: 'acc-1' as string | null } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))

    rerender({ id: null })
    expect(result.current.campaigns).toEqual([])
    expect(result.current.mappings).toEqual({})
  })

  it('reloads when accountId changes', async () => {
    const getCampaigns = vi.fn()
      .mockResolvedValueOnce(CAMPAIGNS)
      .mockResolvedValueOnce([{ campaign_id: 'c3', campaign_name: 'Fall', location_id: null }])
    const client = makeClient({ getCampaigns })

    const { result, rerender } = renderHook(
      ({ id }) => useCampaignMapper(client, id),
      { initialProps: { id: 'acc-1' as string | null } },
    )
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.campaigns).toEqual(CAMPAIGNS)

    rerender({ id: 'acc-2' })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.campaigns).toEqual([{ campaign_id: 'c3', campaign_name: 'Fall', location_id: null }])
  })

  it('setMapping adds or updates a campaign mapping', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useCampaignMapper(client, 'acc-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.setMapping('c2', 'loc-2'))
    expect(result.current.mappings).toEqual({ c1: 'loc-1', c2: 'loc-2' })
  })

  it('setMapping with null removes the campaign from mappings', async () => {
    const client = makeClient()
    const { result } = renderHook(() => useCampaignMapper(client, 'acc-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.setMapping('c1', null))
    expect(result.current.mappings).toEqual({})
  })

  it('save: calls saveMappings with only mapped campaigns', async () => {
    const saveMappings = vi.fn().mockResolvedValue(undefined)
    const client = makeClient({ saveMappings })
    const { result } = renderHook(() => useCampaignMapper(client, 'acc-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))

    act(() => result.current.setMapping('c2', 'loc-3'))
    await act(async () => { await result.current.save() })

    expect(saveMappings).toHaveBeenCalledWith('acc-1', [
      { campaign_id: 'c1', location_id: 'loc-1' },
      { campaign_id: 'c2', location_id: 'loc-3' },
    ])
    expect(result.current.saving).toBe(false)
  })

  it('sets error on load failure', async () => {
    const client = makeClient({
      getCampaigns: vi.fn().mockRejectedValue(new Error('API error')),
    })
    const { result } = renderHook(() => useCampaignMapper(client, 'acc-1'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.error).toBe('API error')
  })
})
