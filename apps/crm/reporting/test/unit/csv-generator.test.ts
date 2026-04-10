import { describe, it, expect } from 'vitest';
import { generateCsv } from '../../src/services/csv-generator.js';

// ---------------------------------------------------------------------------
// Shared test data — covers all five report types
// ---------------------------------------------------------------------------

const testData = {
  period: '2026-01',
  cost_per_lead: 25,
  exam_conversion_rate: 0.5,
  exam_show_rate: 0.6,
  case_conversion_rate: 0.4,
  cost_per_exam: 50,
  cost_per_case_start: 125,
  revenue_attributed: 40000,
  roas: 5.7,
  lead_response_time: 300,
  time_in_stage: 7200,
  raw: {
    leads: {
      total: 100,
      by_channel: [
        { channel: 'google_ads', count: 60 },
        { channel: 'facebook', count: 40 },
      ],
    },
    conversions: {
      total: 20,
      by_channel: [
        { channel: 'google_ads', count: 12 },
        { channel: 'facebook', count: 8 },
      ],
    },
    adSpend: {
      by_platform: [
        { platform: 'google_ads', total_spend: 5000 },
        { platform: 'facebook_ads', total_spend: 2000 },
      ],
    },
    coordinators: {
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
    },
    pipeline: { by_stage: [] },
    campaigns: { campaigns: [] },
  },
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('csv-generator', () => {
  describe('weekly_summary', () => {
    it('returns a non-empty Buffer', async () => {
      const buf = await generateCsv('weekly_summary', testData);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(0);
    });

    it('CSV contains the period value', async () => {
      const buf = await generateCsv('weekly_summary', testData);
      expect(buf.toString('utf8')).toContain('2026-01');
    });

    it('CSV contains KPI column headers', async () => {
      const buf = await generateCsv('weekly_summary', testData);
      const csv = buf.toString('utf8');
      expect(csv).toContain('cost_per_lead');
      expect(csv).toContain('revenue_attributed');
    });
  });

  describe('monthly_executive', () => {
    it('returns a non-empty Buffer', async () => {
      const buf = await generateCsv('monthly_executive', testData);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(0);
    });

    it('CSV contains the period value', async () => {
      const buf = await generateCsv('monthly_executive', testData);
      expect(buf.toString('utf8')).toContain('2026-01');
    });
  });

  describe('channel_deep_dive', () => {
    it('returns a non-empty Buffer', async () => {
      const buf = await generateCsv('channel_deep_dive', testData);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(0);
    });

    it('CSV includes a row for each channel', async () => {
      const buf = await generateCsv('channel_deep_dive', testData);
      const csv = buf.toString('utf8');
      expect(csv).toContain('google_ads');
      expect(csv).toContain('facebook');
    });

    it('CSV contains channel column header', async () => {
      const buf = await generateCsv('channel_deep_dive', testData);
      expect(buf.toString('utf8')).toContain('channel');
    });
  });

  describe('coordinator_productivity', () => {
    it('returns a non-empty Buffer', async () => {
      const buf = await generateCsv('coordinator_productivity', testData);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(0);
    });

    it('CSV contains coordinator_id value', async () => {
      const buf = await generateCsv('coordinator_productivity', testData);
      expect(buf.toString('utf8')).toContain('coord-1');
    });

    it('CSV contains coordinator_id column header', async () => {
      const buf = await generateCsv('coordinator_productivity', testData);
      expect(buf.toString('utf8')).toContain('coordinator_id');
    });
  });

  describe('lead_source', () => {
    it('returns a non-empty Buffer', async () => {
      const buf = await generateCsv('lead_source', testData);
      expect(Buffer.isBuffer(buf)).toBe(true);
      expect(buf.length).toBeGreaterThan(0);
    });

    it('CSV includes a row for each lead channel', async () => {
      const buf = await generateCsv('lead_source', testData);
      const csv = buf.toString('utf8');
      expect(csv).toContain('google_ads');
      expect(csv).toContain('facebook');
    });

    it('CSV contains pct_of_total column', async () => {
      const buf = await generateCsv('lead_source', testData);
      expect(buf.toString('utf8')).toContain('pct_of_total');
    });
  });
});
