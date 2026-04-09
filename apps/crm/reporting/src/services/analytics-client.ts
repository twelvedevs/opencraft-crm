import { env } from '../env.js';

export interface MetricsParams {
  period: string;
  location_ids?: string[];
  granularity?: string;
  [key: string]: unknown;
}

const TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 500;
const MAX_RETRIES = 1;

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildQueryString(params: MetricsParams): string {
  const qs = new URLSearchParams();

  qs.set('period', params.period);

  if (params.location_ids && params.location_ids.length > 0) {
    for (const id of params.location_ids) {
      qs.append('location_id', id);
    }
  }

  if (params.granularity !== undefined) {
    qs.set('granularity', params.granularity);
  }

  // Forward any extra params (e.g. coordinator_id)
  for (const [key, value] of Object.entries(params)) {
    if (key === 'period' || key === 'location_ids' || key === 'granularity') continue;
    if (value !== undefined && value !== null) {
      qs.set(key, String(value));
    }
  }

  return qs.toString();
}

async function fetchWithRetry(url: string): Promise<Response> {
  let lastError: unknown;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      await sleep(RETRY_DELAY_MS);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);

    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Authorization: `Bearer ${env.ANALYTICS_API_KEY}`,
        },
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (response.status >= 500) {
        lastError = new Error(`Analytics Service responded with ${response.status}`);
        continue;
      }

      return response;
    } catch (err) {
      clearTimeout(timer);
      lastError = err;
      // network error or timeout — retry
    }
  }

  throw lastError;
}

async function getMetrics<T>(path: string, params: MetricsParams): Promise<T> {
  const qs = buildQueryString(params);
  const url = `${env.ANALYTICS_SERVICE_URL}${path}?${qs}`;

  const response = await fetchWithRetry(url);

  if (!response.ok) {
    throw new Error(`Analytics Service responded with ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function getLeadMetrics(params: MetricsParams): Promise<unknown> {
  return getMetrics('/analytics/metrics/leads', params);
}

export function getPipelineMetrics(params: MetricsParams): Promise<unknown> {
  return getMetrics('/analytics/metrics/pipeline', params);
}

export function getConversionMetrics(params: MetricsParams): Promise<unknown> {
  return getMetrics('/analytics/metrics/conversions', params);
}

export function getAdSpendMetrics(params: MetricsParams): Promise<unknown> {
  return getMetrics('/analytics/metrics/ad-spend', params);
}

export function getCoordinatorMetrics(params: MetricsParams): Promise<unknown> {
  return getMetrics('/analytics/metrics/coordinators', params);
}

export function getCampaignMetrics(params: MetricsParams): Promise<unknown> {
  return getMetrics('/analytics/metrics/campaigns', params);
}
