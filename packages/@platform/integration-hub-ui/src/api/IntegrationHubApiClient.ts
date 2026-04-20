import type { IntegrationAccount, CampaignSummary, BackfillJob } from '../types.js'

export class IntegrationHubApiClient {
  private readonly headers: Record<string, string>

  constructor(
    private readonly baseUrl: string,
    token?: string,
  ) {
    this.headers = {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
  }

  async listAccounts(): Promise<IntegrationAccount[]> {
    const res = await fetch(`${this.baseUrl}/integrations/accounts`, { headers: this.headers })
    if (!res.ok) throw new Error(`listAccounts failed: ${res.status}`)
    return res.json()
  }

  async deleteAccount(id: string): Promise<void> {
    const res = await fetch(`${this.baseUrl}/integrations/accounts/${id}`, {
      method: 'DELETE',
      headers: this.headers,
    })
    if (!res.ok) throw new Error(`deleteAccount failed: ${res.status}`)
  }

  getConnectUrl(platform: 'google_ads' | 'facebook_ads', redirectUri: string): string {
    const params = new URLSearchParams({ redirect_uri: redirectUri })
    return `${this.baseUrl}/integrations/connect/${platform}?${params}`
  }

  async getCampaigns(accountId: string): Promise<CampaignSummary[]> {
    const res = await fetch(`${this.baseUrl}/integrations/accounts/${accountId}/campaigns`, {
      headers: this.headers,
    })
    if (!res.ok) throw new Error(`getCampaigns failed: ${res.status}`)
    return res.json()
  }

  async saveMappings(
    accountId: string,
    mappings: { campaign_id: string; location_id: string }[],
  ): Promise<void> {
    const res = await fetch(`${this.baseUrl}/integrations/accounts/${accountId}/mappings`, {
      method: 'PUT',
      headers: this.headers,
      body: JSON.stringify({ mappings }),
    })
    if (!res.ok) throw new Error(`saveMappings failed: ${res.status}`)
  }

  async triggerBackfill(
    accountId: string,
    from: string,
    to: string,
  ): Promise<{ job_id: string }> {
    const res = await fetch(`${this.baseUrl}/integrations/accounts/${accountId}/backfill`, {
      method: 'POST',
      headers: this.headers,
      body: JSON.stringify({ from, to }),
    })
    if (!res.ok) throw new Error(`triggerBackfill failed: ${res.status}`)
    return res.json()
  }

  async getBackfillStatus(accountId: string, jobId: string): Promise<BackfillJob> {
    const res = await fetch(
      `${this.baseUrl}/integrations/accounts/${accountId}/backfill/${jobId}`,
      { headers: this.headers },
    )
    if (!res.ok) throw new Error(`getBackfillStatus failed: ${res.status}`)
    return res.json()
  }
}
