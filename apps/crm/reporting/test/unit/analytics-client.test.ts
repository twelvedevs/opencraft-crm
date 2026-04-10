import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('../../src/env.js', () => ({
  env: {
    ANALYTICS_SERVICE_URL: 'http://analytics-test',
    ANALYTICS_API_KEY: 'test-key',
  },
}));

import { getLeadMetrics } from '../../src/services/analytics-client.js';

const mockFetch = vi.fn();

describe('analytics-client', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', mockFetch);
    vi.useFakeTimers();
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  function okResponse(data: unknown) {
    return {
      status: 200,
      ok: true,
      json: async () => data,
    };
  }

  describe('AbortSignal timeout', () => {
    it('attaches an AbortSignal to each fetch call', async () => {
      mockFetch.mockResolvedValue(okResponse({ total: 5 }));

      await getLeadMetrics({ period: '2026-01' });

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect(opts.signal).toBeInstanceOf(AbortSignal);
    });

    it('signal is not initially aborted', async () => {
      mockFetch.mockResolvedValue(okResponse({ total: 5 }));

      await getLeadMetrics({ period: '2026-01' });

      const [, opts] = mockFetch.mock.calls[0] as [string, RequestInit];
      expect((opts.signal as AbortSignal).aborted).toBe(false);
    });
  });

  describe('retry on 5xx', () => {
    it('retries once when first response is 5xx, succeeds on retry', async () => {
      mockFetch
        .mockResolvedValueOnce({ status: 500, ok: false })
        .mockResolvedValueOnce(okResponse({ total: 7 }));

      const promise = getLeadMetrics({ period: '2026-01' });
      await vi.advanceTimersByTimeAsync(600);
      const result = await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ total: 7 });
    });
  });

  describe('retry on network error', () => {
    it('retries once when first call throws, succeeds on retry', async () => {
      mockFetch
        .mockRejectedValueOnce(new Error('Network failure'))
        .mockResolvedValueOnce(okResponse({ total: 3 }));

      const promise = getLeadMetrics({ period: '2026-01' });
      await vi.advanceTimersByTimeAsync(600);
      const result = await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(result).toEqual({ total: 3 });
    });
  });

  describe('no retry on 4xx', () => {
    it('throws immediately without retry on 4xx response', async () => {
      mockFetch.mockResolvedValue({ status: 404, ok: false });

      await expect(getLeadMetrics({ period: '2026-01' })).rejects.toThrow('404');
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe('exhausted retries', () => {
    it('throws last error after both attempts fail with 5xx', async () => {
      mockFetch
        .mockResolvedValueOnce({ status: 500, ok: false })
        .mockResolvedValueOnce({ status: 503, ok: false });

      const promise = getLeadMetrics({ period: '2026-01' });
      // Attach the rejection handler BEFORE advancing timers so the rejection
      // that occurs during advanceTimersByTimeAsync is never unhandled.
      const assertion = expect(promise).rejects.toThrow('503');
      await vi.advanceTimersByTimeAsync(600);
      await assertion;
      expect(mockFetch).toHaveBeenCalledTimes(2);
    });
  });

  describe('location_ids query param', () => {
    beforeEach(() => {
      mockFetch.mockResolvedValue(okResponse({ total: 0, by_channel: [] }));
    });

    it('omits location_id param when location_ids is undefined', async () => {
      await getLeadMetrics({ period: '2026-01' });
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).not.toContain('location_id');
    });

    it('omits location_id param when location_ids is empty array', async () => {
      await getLeadMetrics({ period: '2026-01', location_ids: [] });
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).not.toContain('location_id');
    });

    it('includes location_id params for non-empty location_ids', async () => {
      await getLeadMetrics({ period: '2026-01', location_ids: ['loc-1', 'loc-2'] });
      const url = mockFetch.mock.calls[0][0] as string;
      expect(url).toContain('location_id=loc-1');
      expect(url).toContain('location_id=loc-2');
    });
  });
});
