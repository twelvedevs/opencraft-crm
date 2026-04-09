import { Type, Static } from '@sinclair/typebox';

export const RunStatus = Type.Union([
  Type.Literal('pending'),
  Type.Literal('running'),
  Type.Literal('done'),
  Type.Literal('failed'),
]);

export type RunStatus = Static<typeof RunStatus>;

export const RunResponse = Type.Object({
  id: Type.String(),
  report_config_id: Type.String(),
  report_schedule_id: Type.Union([Type.String(), Type.Null()]),
  triggered_by: Type.String(),
  format: Type.String(),
  status: RunStatus,
  media_file_id: Type.Union([Type.String(), Type.Null()]),
  error_message: Type.Union([Type.String(), Type.Null()]),
  started_at: Type.String(),
  completed_at: Type.Union([Type.String(), Type.Null()]),
  recipient_emails: Type.Union([Type.Array(Type.String()), Type.Null()]),
});

export type RunResponse = Static<typeof RunResponse>;
