import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { IntegrationHubApiClient } from '../../src/api/IntegrationHubApiClient.js'

const BASE = 'http://localhost:3000'
const TOKEN = 'test-token'

function mockFetch(body: unknown, ok = true, status = 200) {
  return vi.fn().mockResolvedValue({
    ok,
    status,
    json: async () => body,
  })
}

describe('IntegrationHubApiClient', () => {
  let client: IntegrationHubApiClient

  beforeEach(() => {
    client = new IntegrationHubApiClient(BASE, TOKEN)
  })

  afterEach(() => vi.unstubAllGlobals())

  describe('listAccounts', () => {
    it('GET /integrations/accounts with auth header', async () => {
      const accounts = [{ id: '1', platform: 'google_ads', status: 'active' }]
      vi.stubGlobal('fetch', mockFetch(accounts))

      const result = await client.listAccounts()

      expect(fetch).toHaveBeenCalledWith(`${BASE}/integrations/accounts`, {
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
      })
      expect(result).toEqual(accounts)
    })

    it('throws on non-ok response', async () => {
      vi.stubGlobal('fetch', mockFetch(null, false, 401))
      await expect(client.listAccounts()).rejects.toThrow('401')
    })
  })

  describe('deleteAccount', () => {
    it('DELETE /integrations/accounts/:id', async () => {
      vi.stubGlobal('fetch', mockFetch(null))
      await client.deleteAccount('abc')
      expect(fetch).toHaveBeenCalledWith(`${BASE}/integrations/accounts/abc`, {
        method: 'DELETE',
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          'Content-Type': 'application/json',
        },
      })
    })

    it('throws on non-ok response', async () => {
      vi.stubGlobal('fetch', mockFetch(null, false, 404))
      await expect(client.deleteAccount('missing')).rejects.toThrow('404')
    })
  })

  describe('getConnectUrl', () => {
    it('builds backend URL with platform and redirect_uri', () => {
      const url = client.getConnectUrl('google_ads', '/settings/integrations/callback')
      expect(url).toBe(
        `${BASE}/integrations/connect/google_ads?redirect_uri=%2Fsettings%2Fintegrations%2Fcallback`,
      )
    })

    it('handles facebook_ads platform', () => {
      const url = client.getConnectUrl('facebook_ads', '/cb')
      expect(url).toContain('/integrations/connect/facebook_ads')
    })
  })

  describe('getCampaigns', () => {
    it('GET /integrations/accounts/:id/campaigns', async () => {
      const campaigns = [{ campaign_id: 'c1', campaign_name: 'Spring', location_id: null }]
      vi.stubGlobal('fetch', mockFetch(campaigns))

      const result = await client.getCampaigns('acc1')

      expect(fetch).toHaveBeenCalledWith(`${BASE}/integrations/accounts/acc1/campaigns`, {
        headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
      })
      expect(result).toEqual(campaigns)
    })
  })

  describe('saveMappings', () => {
    it('PUT /integrations/accounts/:id/mappings with mappings body', async () => {
      vi.stubGlobal('fetch', mockFetch(null))
      const mappings = [{ campaign_id: 'c1', location_id: 'loc1' }]

      await client.saveMappings('acc1', mappings)

      expect(fetch).toHaveBeenCalledWith(`${BASE}/integrations/accounts/acc1/mappings`, {
        method: 'PUT',
        headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
        body: JSON.stringify({ mappings }),
      })
    })
  })

  describe('triggerBackfill', () => {
    it('POST /integrations/accounts/:id/backfill with from/to body', async () => {
      vi.stubGlobal('fetch', mockFetch({ job_id: 'job-1' }))

      const result = await client.triggerBackfill('acc1', '2026-01-01', '2026-03-31')

      expect(result).toEqual({ job_id: 'job-1' })
      expect(fetch).toHaveBeenCalledWith(`${BASE}/integrations/accounts/acc1/backfill`, {
        method: 'POST',
        headers: expect.objectContaining({ Authorization: `Bearer ${TOKEN}` }),
        body: JSON.stringify({ from: '2026-01-01', to: '2026-03-31' }),
      })
    })
  })

  describe('getBackfillStatus', () => {
    it('GET /integrations/accounts/:id/backfill/:job_id', async () => {
      const job = {
        job_id: 'job-1',
        status: 'completed',
        from_date: '2026-01-01',
        to_date: '2026-03-31',
        progress: { chunks_done: 13, chunks_total: 13 },
      }
      vi.stubGlobal('fetch', mockFetch(job))

      const result = await client.getBackfillStatus('acc1', 'job-1')

      expect(result).toEqual(job)
      expect(fetch).toHaveBeenCalledWith(
        `${BASE}/integrations/accounts/acc1/backfill/job-1`,
        expect.any(Object),
      )
    })
  })
})
