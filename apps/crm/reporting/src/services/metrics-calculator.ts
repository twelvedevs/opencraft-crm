import {
  getLeadMetrics,
  getPipelineMetrics,
  getConversionMetrics,
  getAdSpendMetrics,
  getCoordinatorMetrics,
  getCampaignMetrics,
  type MetricsParams,
} from './analytics-client.js';
import * as revenueConfigRepo from '../repositories/revenue-config.js';
import db from '../db.js';

// --- Analytics Service response shapes (inferred from spec Sections 3.1 and 8.2) ---

export interface LeadsByChannel {
  channel: string;
  count: number;
}

export interface LeadMetricsData {
  total: number;
  by_channel: LeadsByChannel[];
}

export interface StageEntry {
  stage: string;
  entries: number;
}

export interface PipelineMetricsData {
  by_stage: StageEntry[];
}

export interface ConversionsByChannel {
  channel: string;
  count: number;
}

export interface ConversionMetricsData {
  total: number;
  by_channel: ConversionsByChannel[];
}

export interface SpendByPlatform {
  platform: string;
  total_spend: number;
}

export interface AdSpendMetricsData {
  by_platform: SpendByPlatform[];
}

export interface CoordinatorStat {
  coordinator_id: string;
  stage_transitions: number;
  exams_booked: number;
  conversions: number;
  avg_response_time_seconds: number | null;
  avg_time_in_stage_seconds: number | null;
}

export interface CoordinatorMetricsData {
  coordinators: CoordinatorStat[];
}

export interface CampaignStat {
  campaign_id: string;
  campaign_name: string;
  sent: number;
  delivered: number;
  opened: number;
  clicked: number;
  conversions: number;
}

export interface CampaignMetricsData {
  campaigns: CampaignStat[];
}

export interface AnalyticsRawData {
  leads: LeadMetricsData;
  pipeline: PipelineMetricsData;
  conversions: ConversionMetricsData;
  adSpend: AdSpendMetricsData;
  coordinators: CoordinatorMetricsData;
  campaigns: CampaignMetricsData;
}

export interface ComputedMetrics {
  cost_per_lead: number | null;
  exam_conversion_rate: number | null;
  exam_show_rate: number | null;
  case_conversion_rate: number | null;
  cost_per_exam: number | null;
  cost_per_case_start: number | null;
  revenue_attributed: number | null;
  roas: number | null;
  lead_response_time: number | null;
  time_in_stage: number | null;
  missing_revenue_config: string[];
  // Raw analytics data for per-channel, per-location, and per-coordinator views
  raw: AnalyticsRawData;
}

// Channel → ad platform attribution (spec Section 3.2)
const CHANNEL_TO_PLATFORM: Record<string, string> = {
  google_ads: 'google_ads',
  facebook: 'facebook_ads',
};

function divOrNull(numerator: number, denominator: number): number | null {
  return denominator === 0 ? null : numerator / denominator;
}

function averageOrNull(values: (number | null)[]): number | null {
  const nums = values.filter((v): v is number => v !== null);
  if (nums.length === 0) return null;
  return nums.reduce((sum, v) => sum + v, 0) / nums.length;
}

/**
 * Fans out parallel calls to all Analytics Service endpoints and computes all
 * Ortho-specific KPIs. Fails fast via Promise.all — if any call throws, the
 * entire computation rejects.
 *
 * When params.location_ids is undefined or empty (marketing roles with all-location
 * access), the analytics-client omits the location_id param from requests — callers
 * must pass undefined rather than [].
 */
export async function computeMetrics(params: MetricsParams): Promise<ComputedMetrics> {
  // Fan out all six Analytics Service calls in parallel — fail-fast
  const [leads, pipeline, conversions, adSpend, coordinators, campaigns] =
    await Promise.all([
      getLeadMetrics(params) as Promise<LeadMetricsData>,
      getPipelineMetrics(params) as Promise<PipelineMetricsData>,
      getConversionMetrics(params) as Promise<ConversionMetricsData>,
      getAdSpendMetrics(params) as Promise<AdSpendMetricsData>,
      getCoordinatorMetrics(params) as Promise<CoordinatorMetricsData>,
      getCampaignMetrics(params) as Promise<CampaignMetricsData>,
    ]);

  // --- Extract aggregate counts ---
  const leads_total = leads.total;

  const exam_scheduled =
    pipeline.by_stage.find(s => s.stage === 'exam_scheduled')?.entries ?? 0;
  const exam_completed =
    pipeline.by_stage.find(s => s.stage === 'exam_completed')?.entries ?? 0;

  const conversions_total = conversions.total;

  const ad_spend_total = adSpend.by_platform.reduce(
    (sum, p) => sum + p.total_spend,
    0,
  );

  // --- Coordinator averages (average of per-coordinator reported averages) ---
  const lead_response_time = averageOrNull(
    coordinators.coordinators.map(c => c.avg_response_time_seconds),
  );
  const time_in_stage = averageOrNull(
    coordinators.coordinators.map(c => c.avg_time_in_stage_seconds),
  );

  // --- Revenue config lookup for revenue_attributed and ROAS ---
  const location_ids = params.location_ids ?? [];
  const missing_revenue_config: string[] = [];
  let avg_contract_value: number | null = null;

  if (location_ids.length > 0) {
    const configs = await revenueConfigRepo.findByLocationIds(db, location_ids);
    const configMap = new Map(
      configs.map(c => [c.location_id, Number(c.avg_contract_value)]),
    );

    for (const id of location_ids) {
      if (!configMap.has(id)) {
        missing_revenue_config.push(id);
      }
    }

    // Only compute avg_contract_value when ALL requested locations have configs
    if (missing_revenue_config.length === 0 && configs.length > 0) {
      avg_contract_value =
        configs.reduce((sum, c) => sum + Number(c.avg_contract_value), 0) /
        configs.length;
    }
  } else {
    // All-locations query — load every available config; missing list is not
    // computable (we don't know which location IDs exist)
    const configs = await revenueConfigRepo.findAll(db);
    if (configs.length > 0) {
      avg_contract_value =
        configs.reduce((sum, c) => sum + Number(c.avg_contract_value), 0) /
        configs.length;
    }
  }

  const revenue_attributed =
    avg_contract_value !== null
      ? conversions_total * avg_contract_value
      : null;

  const roas =
    revenue_attributed !== null
      ? divOrNull(revenue_attributed, ad_spend_total)
      : null;

  return {
    cost_per_lead: divOrNull(ad_spend_total, leads_total),
    exam_conversion_rate: divOrNull(exam_scheduled, leads_total),
    exam_show_rate: divOrNull(exam_completed, exam_scheduled),
    case_conversion_rate: divOrNull(conversions_total, exam_completed),
    cost_per_exam: divOrNull(ad_spend_total, exam_completed),
    cost_per_case_start: divOrNull(ad_spend_total, conversions_total),
    revenue_attributed,
    roas,
    lead_response_time,
    time_in_stage,
    missing_revenue_config,
    raw: { leads, pipeline, conversions, adSpend, coordinators, campaigns },
  };
}

export { CHANNEL_TO_PLATFORM };
