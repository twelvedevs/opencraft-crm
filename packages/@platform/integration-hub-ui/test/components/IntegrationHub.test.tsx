import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { IntegrationHub } from '../../src/components/IntegrationHub.js'
import type { IntegrationHubApiClient } from '../../src/api/IntegrationHubApiClient.js'

const LOCATIONS = [
  { id: 'loc-1', name: 'North Seattle' },
  { id: 'loc-2', name: 'Bellevue' },
]

const ACCOUNT_GOOGLE = {
  id: 'acc-1',
  platform: 'google_ads' as const,
  account_id: 'g-123',
  account_name: 'My Google Ads',
  status: 'active' as const,
  last_error: null,
  last_polled_at: null,
}

const CAMPAIGNS = [
  { campaign_id: 'c1', campaign_name: 'Spring Promo', location_id: null },
  { campaign_id: 'c2', campaign_name: 'Summer Sale', location_id: 'loc-1' },
]

function makeClient(overrides: Partial<InstanceType<typeof IntegrationHubApiClient>> = {}) {
  return {
    listAccounts: vi.fn().mockResolvedValue([ACCOUNT_GOOGLE]),
    deleteAccount: vi.fn().mockResolvedValue(undefined),
    getConnectUrl: vi.fn().mockReturnValue('http://localhost:3000/integrations/connect/facebook_ads?redirect_uri=%2Fcb'),
    getCampaigns: vi.fn().mockResolvedValue(CAMPAIGNS),
    saveMappings: vi.fn().mockResolvedValue(undefined),
    triggerBackfill: vi.fn().mockResolvedValue({ job_id: 'job-1' }),
    getBackfillStatus: vi.fn().mockResolvedValue({
      job_id: 'job-1',
      status: 'active',
      from_date: '2026-01-01',
      to_date: '2026-03-31',
      progress: { chunks_done: 0, chunks_total: 13 },
    }),
    ...overrides,
  } as unknown as InstanceType<typeof IntegrationHubApiClient>
}

describe('IntegrationHub', () => {
  it('renders loading state then shows accounts', async () => {
    const client = makeClient()
    render(<IntegrationHub client={client} locations={LOCATIONS} connectReturnUrl="/cb" />)
    await waitFor(() => expect(screen.getByText('Google Ads')).toBeTruthy())
  })

  it('auto-selects first account and loads its campaigns', async () => {
    const client = makeClient()
    render(<IntegrationHub client={client} locations={LOCATIONS} connectReturnUrl="/cb" />)
    await waitFor(() => expect(screen.getByText('Spring Promo')).toBeTruthy())
    expect(screen.getByText('Summer Sale')).toBeTruthy()
  })

  it('shows Connect Meta button for unconnected platform', async () => {
    const client = makeClient()
    render(<IntegrationHub client={client} locations={LOCATIONS} connectReturnUrl="/cb" />)
    await waitFor(() => expect(screen.getByText(/Connect Meta/i)).toBeTruthy())
  })

  it('does not show Connect Google Ads button when already connected', async () => {
    const client = makeClient()
    render(<IntegrationHub client={client} locations={LOCATIONS} connectReturnUrl="/cb" />)
    await waitFor(() => expect(screen.getByText('Google Ads')).toBeTruthy())
    expect(screen.queryByText(/Connect Google Ads/i)).toBeNull()
  })

  it('saves mappings when Save Mappings is clicked', async () => {
    const saveMappings = vi.fn().mockResolvedValue(undefined)
    const client = makeClient({ saveMappings })
    render(<IntegrationHub client={client} locations={LOCATIONS} connectReturnUrl="/cb" />)
    await waitFor(() => expect(screen.getByText('Spring Promo')).toBeTruthy())

    fireEvent.click(screen.getByText('Save Mappings'))
    await waitFor(() => expect(saveMappings).toHaveBeenCalledWith('acc-1', [
      { campaign_id: 'c2', location_id: 'loc-1' },
    ]))
  })

  it('shows empty state when no accounts connected', async () => {
    const client = makeClient({ listAccounts: vi.fn().mockResolvedValue([]) })
    render(<IntegrationHub client={client} locations={LOCATIONS} connectReturnUrl="/cb" />)
    await waitFor(() => expect(screen.getByText(/Connect your first/i)).toBeTruthy())
  })

  it('disconnects account and reloads', async () => {
    const deleteAccount = vi.fn().mockResolvedValue(undefined)
    const listAccounts = vi.fn()
      .mockResolvedValueOnce([ACCOUNT_GOOGLE])
      .mockResolvedValueOnce([])
    const client = makeClient({ deleteAccount, listAccounts, getCampaigns: vi.fn().mockResolvedValue(CAMPAIGNS) })
    render(<IntegrationHub client={client} locations={LOCATIONS} connectReturnUrl="/cb" />)
    await waitFor(() => expect(screen.getByText('Disconnect')).toBeTruthy())

    fireEvent.click(screen.getByText('Disconnect'))
    await waitFor(() => expect(deleteAccount).toHaveBeenCalledWith('acc-1'))
    await waitFor(() => expect(screen.getByText(/Connect your first/i)).toBeTruthy())
  })
})
