import { createHash } from 'node:crypto';
import { LRUCache } from 'lru-cache';
import { computeMetrics, type ComputedMetrics } from './metrics-calculator.js';
import { type MetricsParams } from './analytics-client.js';
import { env } from '../env.js';

const cache = new LRUCache<string, ComputedMetrics>({
  max: env.LRU_CACHE_MAX,
  ttl: env.LRU_CACHE_TTL_MS,
});

function buildCacheKey(metric_family: string, params: MetricsParams): string {
  const sortedLocations = [...(params.location_ids ?? [])].sort().join(',');
  const raw = `${metric_family}|${params.period}|${sortedLocations}`;
  return createHash('sha256').update(raw).digest('hex');
}

export async function getMetrics(
  metric_family: string,
  params: MetricsParams,
): Promise<ComputedMetrics> {
  const key = buildCacheKey(metric_family, params);

  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  const result = await computeMetrics(params);
  cache.set(key, result);
  return result;
}
