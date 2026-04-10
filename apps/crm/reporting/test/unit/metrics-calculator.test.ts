import { vi, describe, it, expect, beforeEach } from 'vitest';

vi.mock('../../src/services/analytics-client.js', () => ({
  getLeadMetrics: vi.fn(),
  getPipelineMetrics: vi.fn(),
  getConversionMetrics: vi.fn(),
  getAdSpendMetrics: vi.fn(),
  getCoordinatorMetrics: vi.fn(),
  getCampaignMetrics: vi.fn(),
}));

vi.mock('../../src/repositories/revenue-config.js', () => ({
  findByLocationIds: vi.fn(),
  findAll: vi.fn(),
}));

vi.mock('../../src/db.js', () => ({
  default: {},
}));

import { computeMetrics, CHANNEL_TO_PLATFORM } from '../../src/services/metrics-calculator.js';
import * as analyticsClient from '../../src/services/analytics-client.js';
import * as revenueConfigRepo from '../../src/repositories/revenue-config.js';

// ---------------------------------------------------------------------------
// Default analytics response fixtures
// ---------------------------------------------------------------------------

const defaultLeads = {
  total: 100,
  by_channel: [
    { channel: 'google_ads', count: 60 },
    { channel: 'facebook', count: 40 },
  ],
};

const defaultPipeline = {
  by_stage: [
    { stage: 'exam_scheduled', entries: 50 },
    { stage: 'exam_completed', entries: 30 },
  ],
};

const defaultConversions = {
  total: 20,
  by_channel: [
    { channel: 'google_ads', count: 12 },
    { channel: 'facebook', count: 8 },
  ],
};

const defaultAdSpend = {
  by_platform: [
    { platform: 'google_ads', total_spend: 5000 },
    { platform: 'facebook_ads', total_spend: 2000 },
  ],
};

const defaultCoordinators = {
  coordinators: [
    {
      coordinator_id: 'coord-1',
      stage_transitions: 15,
      exams_booked: 10,
      conversions: 5,
      avg_response_time_seconds: 300,
      avg_time_in_stage_seconds: 3600,
    },
  ],
};

const defaultCampaigns = { campaigns: [] };

function setupDefaultMocks() {
  vi.mocked(analyticsClient.getLeadMetrics).mockResolvedValue(defaultLeads);
  vi.mocked(analyticsClient.getPipelineMetrics).mockResolvedValue(defaultPipeline);
  vi.mocked(analyticsClient.getConversionMetrics).mockResolvedValue(defaultConversions);
  vi.mocked(analyticsClient.getAdSpendMetrics).mockResolvedValue(defaultAdSpend);
  vi.mocked(analyticsClient.getCoordinatorMetrics).mockResolvedValue(defaultCoordinators);
  vi.mocked(analyticsClient.getCampaignMetrics).mockResolvedValue(defaultCampaigns);
  vi.mocked(revenueConfigRepo.findAll).mockResolvedValue([]);
  vi.mocked(revenueConfigRepo.findByLocationIds).mockResolvedValue([]);
}

beforeEach(() => {
  vi.clearAllMocks();
  setupDefaultMocks();
});

// ---------------------------------------------------------------------------
// CHANNEL_TO_PLATFORM map
// ---------------------------------------------------------------------------

describe('CHANNEL_TO_PLATFORM', () => {
  it('maps google_ads → google_ads platform', () => {
    expect(CHANNEL_TO_PLATFORM['google_ads']).toBe('google_ads');
  });

  it('maps facebook → facebook_ads platform', () => {
    expect(CHANNEL_TO_PLATFORM['facebook']).toBe('facebook_ads');
  });
});

// ---------------------------------------------------------------------------
// Ratio KPIs — null when denominator is zero
// ---------------------------------------------------------------------------

describe('ratio KPIs with zero denominators', () => {
  it('cost_per_lead is null when leads total is 0', async () => {
    vi.mocked(analyticsClient.getLeadMetrics).mockResolvedValue({ total: 0, by_channel: [] });

    const result = await computeMetrics({ period: '2026-01' });

    expect(result.cost_per_lead).toBeNull();
  });

  it('exam_conversion_rate is null when leads total is 0', async () => {
    vi.mocked(analyticsClient.getLeadMetrics).mockResolvedValue({ total: 0, by_channel: [] });

    const result = await computeMetrics({ period: '2026-01' });

    expect(result.exam_conversion_rate).toBeNull();
  });

  it('all rate KPIs are null when exam_scheduled and exam_completed are 0', async () => {
    vi.mocked(analyticsClient.getPipelineMetrics).mockResolvedValue({
      by_stage: [
        { stage: 'exam_scheduled', entries: 0 },
        { stage: 'exam_completed', entries: 0 },
      ],
    });
    vi.mocked(analyticsClient.getConversionMetrics).mockResolvedValue({ total: 0, by_channel: [] });

    const result = await computeMetrics({ period: '2026-01' });

    expect(result.exam_show_rate).toBeNull();
    expect(result.case_conversion_rate).toBeNull();
    expect(result.cost_per_exam).toBeNull();
    expect(result.cost_per_case_start).toBeNull();
  });

  it('cost_per_case_start is null when conversions total is 0', async () => {
    vi.mocked(analyticsClient.getConversionMetrics).mockResolvedValue({ total: 0, by_channel: [] });

    const result = await computeMetrics({ period: '2026-01' });

    expect(result.cost_per_case_start).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Revenue config and attributed revenue
// ---------------------------------------------------------------------------

describe('revenue_attributed with missing config', () => {
  it('returns null revenue_attributed and roas when no config for requested location', async () => {
    vi.mocked(revenueConfigRepo.findByLocationIds).mockResolvedValue([]);

    const result = await computeMetrics({ period: '2026-01', location_ids: ['loc-1'] });

    expect(result.revenue_attributed).toBeNull();
    expect(result.roas).toBeNull();
  });

  it('includes missing location in missing_revenue_config array', async () => {
    vi.mocked(revenueConfigRepo.findByLocationIds).mockResolvedValue([]);

    const result = await computeMetrics({ period: '2026-01', location_ids: ['loc-1'] });

    expect(result.missing_revenue_config).toContain('loc-1');
  });

  it('lists only locations without config, not ones with config', async () => {
    vi.mocked(revenueConfigRepo.findByLocationIds).mockResolvedValue([
      { location_id: 'loc-1', avg_contract_value: 5000, updated_at: new Date(), updated_by: 'user' },
    ]);

    const result = await computeMetrics({
      period: '2026-01',
      location_ids: ['loc-1', 'loc-2'],
    });

    expect(result.missing_revenue_config).not.toContain('loc-1');
    expect(result.missing_revenue_config).toContain('loc-2');
    expect(result.revenue_attributed).toBeNull(); // partial config → still null
  });

  it('computes revenue_attributed when all requested locations have config', async () => {
    vi.mocked(analyticsClient.getConversionMetrics).mockResolvedValue({
      total: 10,
      by_channel: [],
    });
    vi.mocked(revenueConfigRepo.findByLocationIds).mockResolvedValue([
      { location_id: 'loc-1', avg_contract_value: 5000, updated_at: new Date(), updated_by: 'user' },
    ]);

    const result = await computeMetrics({ period: '2026-01', location_ids: ['loc-1'] });

    expect(result.revenue_attributed).toBe(50000); // 10 conversions × $5000
    expect(result.missing_revenue_config).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Promise.all error propagation
// ---------------------------------------------------------------------------

describe('error propagation', () => {
  it('rejects if any analytics call fails (fail-fast)', async () => {
    vi.mocked(analyticsClient.getLeadMetrics).mockRejectedValue(new Error('Analytics down'));

    await expect(computeMetrics({ period: '2026-01' })).rejects.toThrow('Analytics down');
  });

  it('rejects even when only one of six calls fails', async () => {
    vi.mocked(analyticsClient.getAdSpendMetrics).mockRejectedValue(
      new Error('Ad spend service error'),
    );

    await expect(computeMetrics({ period: '2026-01' })).rejects.toThrow('Ad spend service error');
  });
});

// ---------------------------------------------------------------------------
// Raw data passthrough
// ---------------------------------------------------------------------------

describe('raw analytics data', () => {
  it('includes raw leads, pipeline, conversions, adSpend, coordinators, campaigns in result', async () => {
    const result = await computeMetrics({ period: '2026-01' });

    expect(result.raw.leads).toEqual(defaultLeads);
    expect(result.raw.pipeline).toEqual(defaultPipeline);
    expect(result.raw.conversions).toEqual(defaultConversions);
    expect(result.raw.adSpend).toEqual(defaultAdSpend);
    expect(result.raw.coordinators).toEqual(defaultCoordinators);
    expect(result.raw.campaigns).toEqual(defaultCampaigns);
  });
});
