import { Type, Static } from '@sinclair/typebox';

export const ReportType = Type.Union([
  Type.Literal('weekly_summary'),
  Type.Literal('monthly_executive'),
  Type.Literal('channel_deep_dive'),
  Type.Literal('coordinator_productivity'),
  Type.Literal('lead_source'),
]);

export type ReportType = Static<typeof ReportType>;

const ReportParameters = Type.Object({
  period_type: Type.Optional(
    Type.Union([
      Type.Literal('last_30d'),
      Type.Literal('last_month'),
      Type.Literal('custom'),
    ]),
  ),
  from: Type.Optional(Type.String()),
  to: Type.Optional(Type.String()),
  location_ids: Type.Optional(Type.Array(Type.String())),
  channel: Type.Optional(Type.Array(Type.String())),
});

export type ReportParameters = Static<typeof ReportParameters>;

export const ReportConfigBody = Type.Object({
  name: Type.String(),
  report_type: ReportType,
  parameters: Type.Optional(ReportParameters),
});

export type ReportConfigBody = Static<typeof ReportConfigBody>;

export const ReportConfigParams = Type.Object({
  id: Type.String(),
});

export type ReportConfigParams = Static<typeof ReportConfigParams>;

export const ReportConfigResponse = Type.Object({
  id: Type.String(),
  name: Type.String(),
  report_type: ReportType,
  parameters: ReportParameters,
  created_by: Type.String(),
  created_at: Type.String(),
  updated_at: Type.String(),
});

export type ReportConfigResponse = Static<typeof ReportConfigResponse>;
