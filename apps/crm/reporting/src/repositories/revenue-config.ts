import type { Knex } from 'knex';

const TABLE = 'crm_reporting.location_revenue_config';

export interface LocationRevenueConfig {
  location_id: string;
  avg_contract_value: number;
  updated_at: Date;
  updated_by: string;
}

export async function findByLocationId(
  db: Knex,
  locationId: string,
): Promise<LocationRevenueConfig | null> {
  const row = await db(TABLE).where({ location_id: locationId }).first();
  return (row as LocationRevenueConfig) ?? null;
}

export async function findAll(db: Knex): Promise<LocationRevenueConfig[]> {
  return (await db(TABLE).orderBy('location_id')) as LocationRevenueConfig[];
}

export async function findByLocationIds(
  db: Knex,
  ids: string[],
): Promise<LocationRevenueConfig[]> {
  return (await db(TABLE).whereIn('location_id', ids)) as LocationRevenueConfig[];
}

export async function upsert(
  db: Knex,
  locationId: string,
  avgContractValue: number,
  updatedBy: string,
): Promise<LocationRevenueConfig> {
  const [row] = await db(TABLE)
    .insert({
      location_id: locationId,
      avg_contract_value: avgContractValue,
      updated_by: updatedBy,
      updated_at: db.fn.now(),
    })
    .onConflict('location_id')
    .merge({
      avg_contract_value: avgContractValue,
      updated_by: updatedBy,
      updated_at: db.fn.now(),
    })
    .returning('*');
  return row as LocationRevenueConfig;
}
