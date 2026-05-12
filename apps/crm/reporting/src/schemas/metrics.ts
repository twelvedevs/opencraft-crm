import { Type, Static } from '@sinclair/typebox';

// YYYY-MM or YYYY-MM-DD/YYYY-MM-DD
export const PeriodParam = Type.String({
  pattern: '^\\d{4}-\\d{2}$|^\\d{4}-\\d{2}-\\d{2}/\\d{4}-\\d{2}-\\d{2}$',
});

export type PeriodParam = Static<typeof PeriodParam>;

export const MetricsQueryParams = Type.Object({
  period: PeriodParam,
  location_id: Type.Optional(Type.Array(Type.String())),
  granularity: Type.Optional(
    Type.Union([
      Type.Literal('daily'),
      Type.Literal('monthly'),
      Type.Literal('total'),
    ]),
  ),
});

export type MetricsQueryParams = Static<typeof MetricsQueryParams>;

// Shared nullable number helper (not exported — internal to this module)
const NullableNumber = Type.Union([Type.Number(), Type.Null()]);

// Core KPIs returned on the dashboard
const CoreKpis = Type.Object({
  cost_per_lead: NullableNumber,
  exam_conversion_rate: NullableNumber,
  exam_show_rate: NullableNumber,
  case_conversion_rate: NullableNumber,
  cost_per_exam: NullableNumber,
  cost_per_case_start: NullableNumber,
  revenue_attributed: NullableNumber,
  roas: NullableNumber,
  lead_response_time: NullableNumber,
  time_in_stage: NullableNumber,
});

export const DashboardResponse = Type.Object({
  period: Type.String(),
  granularity: Type.Optional(Type.String()),
  kpis: CoreKpis,
  missing_revenue_config: Type.Array(Type.String()),
});

export type DashboardResponse = Static<typeof DashboardResponse>;

// Channel performance
const ChannelMetrics = Type.Object({
  channel: Type.String(),
  leads: Type.Integer(),
  exam_conversion_rate: NullableNumber,
  exam_show_rate: NullableNumber,
  case_conversion_rate: NullableNumber,
  ad_spend: NullableNumber,
  cost_per_lead: NullableNumber,
  cost_per_exam: NullableNumber,
  cost_per_case_start: NullableNumber,
});

export type ChannelMetrics = Static<typeof ChannelMetrics>;

export const ChannelPerformanceResponse = Type.Object({
  period: Type.String(),
  channels: Type.Array(ChannelMetrics),
  missing_revenue_config: Type.Array(Type.String()),
});

export type ChannelPerformanceResponse = Static<typeof ChannelPerformanceResponse>;

// Location comparison
const LocationKpis = Type.Object({
  location_id: Type.String(),
  leads: Type.Integer(),
  cost_per_lead: NullableNumber,
  exam_conversion_rate: NullableNumber,
  case_conversion_rate: NullableNumber,
  cost_per_case_start: NullableNumber,
  revenue_attributed: NullableNumber,
  roas: NullableNumber,
});

export type LocationKpis = Static<typeof LocationKpis>;

export const LocationComparisonResponse = Type.Object({
  period: Type.String(),
  locations: Type.Array(LocationKpis),
  network_average: Type.Union([LocationKpis, Type.Null()]),
  missing_revenue_config: Type.Array(Type.String()),
});

export type LocationComparisonResponse = Static<typeof LocationComparisonResponse>;

// Coordinator performance
const CoordinatorMetrics = Type.Object({
  coordinator_id: Type.String(),
  stage_transitions: Type.Integer(),
  exams_booked: Type.Integer(),
  conversions: Type.Integer(),
  avg_response_time_seconds: NullableNumber,
  avg_time_in_stage_seconds: NullableNumber,
});

export type CoordinatorMetrics = Static<typeof CoordinatorMetrics>;

export const CoordinatorPerformanceResponse = Type.Object({
  period: Type.String(),
  coordinators: Type.Array(CoordinatorMetrics),
});

export type CoordinatorPerformanceResponse = Static<typeof CoordinatorPerformanceResponse>;

// Campaign analytics
const CampaignMetrics = Type.Object({
  campaign_id: Type.String(),
  campaign_name: Type.String(),
  sent: Type.Integer(),
  delivered: Type.Integer(),
  opened: Type.Integer(),
  clicked: Type.Integer(),
  conversions: Type.Integer(),
  conversion_rate: NullableNumber,
});

export type CampaignMetrics = Static<typeof CampaignMetrics>;

export const CampaignAnalyticsResponse = Type.Object({
  period: Type.String(),
  campaigns: Type.Array(CampaignMetrics),
});

export type CampaignAnalyticsResponse = Static<typeof CampaignAnalyticsResponse>;
