// Typed wrapper for Google Ads API — uses REST endpoint with pre-decrypted access token.

export const GOOGLE_ADS_API_VERSION = 'v19';

export interface CampaignPerformanceRow {
  campaign_id: string;
  campaign_name: string;
  spend: number;
  impressions: number;
  clicks: number;
  date: string;
}

interface GoogleAdsSearchResponse {
  results?: {
    campaign?: { id?: string; name?: string };
    metrics?: { costMicros?: string; impressions?: string; clicks?: string };
    segments?: { date?: string };
  }[];
  nextPageToken?: string;
}

const BASE_URL = `https://googleads.googleapis.com/${GOOGLE_ADS_API_VERSION}`;

export class GoogleAdsClient {
  private readonly accessToken: string;
  private readonly customerId: string;

  constructor(accessToken: string, customerId: string) {
    this.accessToken = accessToken;
    // Strip hyphens from customer ID (Google Ads API requires plain digits)
    this.customerId = customerId.replace(/-/g, '');
  }

  async searchCampaignPerformance(date: string): Promise<CampaignPerformanceRow[]> {
    const query = `
      SELECT campaign.id, campaign.name,
             metrics.cost_micros, metrics.impressions, metrics.clicks,
             segments.date
      FROM campaign
      WHERE segments.date = '${date}'
    `.trim();

    return this.executeSearch(query);
  }

  async searchCampaignPerformanceRange(from: string, to: string): Promise<CampaignPerformanceRow[]> {
    const query = `
      SELECT campaign.id, campaign.name,
             metrics.cost_micros, metrics.impressions, metrics.clicks,
             segments.date
      FROM campaign
      WHERE segments.date BETWEEN '${from}' AND '${to}'
    `.trim();

    return this.executeSearch(query);
  }

  private async executeSearch(query: string): Promise<CampaignPerformanceRow[]> {
    const rows: CampaignPerformanceRow[] = [];
    let pageToken: string | undefined;

    do {
      const body: Record<string, string> = { query };
      if (pageToken) {
        body['pageToken'] = pageToken;
      }

      const url = `${BASE_URL}/customers/${this.customerId}/googleAds:searchStream`;
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Google Ads API error ${res.status}: ${text}`);
      }

      const data = (await res.json()) as GoogleAdsSearchResponse[];
      for (const batch of data) {
        if (!batch.results) continue;
        for (const row of batch.results) {
          rows.push({
            campaign_id: row.campaign?.id ?? '',
            campaign_name: row.campaign?.name ?? '',
            spend: Number(row.metrics?.costMicros ?? '0') / 1_000_000,
            impressions: Number(row.metrics?.impressions ?? '0'),
            clicks: Number(row.metrics?.clicks ?? '0'),
            date: row.segments?.date ?? '',
          });
        }
      }

      // searchStream returns all results in one response; no pagination
      pageToken = undefined;
    } while (pageToken);

    return rows;
  }
}
