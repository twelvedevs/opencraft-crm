import { Type, Static } from '@sinclair/typebox';

export const ScheduleBody = Type.Object({
  report_config_id: Type.String(),
  frequency: Type.Union([
    Type.Literal('daily'),
    Type.Literal('weekly'),
    Type.Literal('monthly'),
  ]),
  day_of_week: Type.Optional(Type.Integer({ minimum: 0, maximum: 6 })),
  day_of_month: Type.Optional(Type.Integer({ minimum: 1, maximum: 28 })),
  hour_utc: Type.Integer({ minimum: 0, maximum: 23 }),
  recipient_emails: Type.Array(Type.String()),
  format: Type.Optional(
    Type.Union([Type.Literal('pdf'), Type.Literal('csv')]),
  ),
  active: Type.Optional(Type.Boolean()),
});

export type ScheduleBody = Static<typeof ScheduleBody>;

export const ScheduleResponse = Type.Object({
  id: Type.String(),
  report_config_id: Type.String(),
  frequency: Type.String(),
  day_of_week: Type.Union([Type.Integer(), Type.Null()]),
  day_of_month: Type.Union([Type.Integer(), Type.Null()]),
  hour_utc: Type.Integer(),
  recipient_emails: Type.Array(Type.String()),
  format: Type.String(),
  active: Type.Boolean(),
  created_by: Type.String(),
  created_at: Type.String(),
});

export type ScheduleResponse = Static<typeof ScheduleResponse>;
