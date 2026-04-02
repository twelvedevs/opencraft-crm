// Typed wrapper for Meta (Facebook) Marketing API — uses native fetch.

export const META_GRAPH_API_VERSION = 'v22.0';

export interface MetaInsightRow {
  campaign_id: string;
  campaign_name: string;
  spend: string;
  impressions: string;
  clicks: string;
  date_start: string;
}

interface MetaInsightsResponse {
  data?: {
    campaign_id?: string;
    campaign_name?: string;
    spend?: string;
    impressions?: string;
    clicks?: string;
    date_start?: string;
  }[];
  paging?: { next?: string };
  error?: { message?: string; type?: string; code?: number };
}

const BASE_URL = `https://graph.facebook.com/${META_GRAPH_API_VERSION}`;

export class MetaApiClient {
  private readonly accessToken: string;
  private readonly accountId: string;

  constructor(accessToken: string, accountId: string) {
    this.accessToken = accessToken;
    this.accountId = accountId;
  }

  async getInsights(date: string): Promise<MetaInsightRow[]> {
    return this.fetchInsights(date, date);
  }

  async getInsightsRange(from: string, to: string): Promise<MetaInsightRow[]> {
    return this.fetchInsights(from, to);
  }

  async listCampaigns(): Promise<{ campaign_id: string; campaign_name: string }[]> {
    const params = new URLSearchParams({
      fields: 'id,name',
      effective_status: '["ACTIVE","PAUSED"]',
      access_token: this.accessToken,
    });

    const results: { campaign_id: string; campaign_name: string }[] = [];
    let nextUrl: string | undefined =
      `${BASE_URL}/act_${this.accountId}/campaigns?${params.toString()}`;

    while (nextUrl) {
      const res = await fetch(nextUrl);
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as MetaInsightsResponse;
        const metaMsg = data.error?.message ?? '';
        throw new Error(`Meta API error ${res.status}${metaMsg ? `: ${metaMsg}` : ''}`);
      }

      const data = (await res.json()) as {
        data?: { id?: string; name?: string }[];
        paging?: { next?: string };
      };

      if (data.data) {
        for (const row of data.data) {
          results.push({
            campaign_id: row.id ?? '',
            campaign_name: row.name ?? '',
          });
        }
      }

      nextUrl = data.paging?.next;
    }

    return results;
  }

  private async fetchInsights(since: string, until: string): Promise<MetaInsightRow[]> {
    const timeRange = JSON.stringify({ since, until });
    const params = new URLSearchParams({
      fields: 'spend,impressions,clicks,campaign_id,campaign_name',
      time_range: timeRange,
      level: 'campaign',
      access_token: this.accessToken,
    });

    const url = `${BASE_URL}/act_${this.accountId}/insights?${params.toString()}`;
    const rows: MetaInsightRow[] = [];

    let nextUrl: string | undefined = url;

    while (nextUrl) {
      const res = await fetch(nextUrl);

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as MetaInsightsResponse;
        const metaMsg = data.error?.message ?? '';
        throw new Error(
          `Meta API error ${res.status}${metaMsg ? `: ${metaMsg}` : ''}`
        );
      }

      const data = (await res.json()) as MetaInsightsResponse;

      if (data.data) {
        for (const row of data.data) {
          rows.push({
            campaign_id: row.campaign_id ?? '',
            campaign_name: row.campaign_name ?? '',
            spend: row.spend ?? '0',
            impressions: row.impressions ?? '0',
            clicks: row.clicks ?? '0',
            date_start: row.date_start ?? '',
          });
        }
      }

      nextUrl = data.paging?.next;
    }

    return rows;
  }
}
