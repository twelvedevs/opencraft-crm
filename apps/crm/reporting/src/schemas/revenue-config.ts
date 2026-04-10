import { Type, Static } from '@sinclair/typebox';

export const RevenueConfigBody = Type.Object({
  avg_contract_value: Type.Number({ minimum: 0 }),
});

export type RevenueConfigBody = Static<typeof RevenueConfigBody>;

export const RevenueConfigResponse = Type.Object({
  location_id: Type.String(),
  avg_contract_value: Type.Number(),
  updated_at: Type.String(),
});

export type RevenueConfigResponse = Static<typeof RevenueConfigResponse>;
