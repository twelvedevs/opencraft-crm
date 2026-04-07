import type { Knex } from 'knex';

export interface LocationConversationSettings {
  location_id: string;
  inactivity_days: number;
  agent_mode_enabled: boolean;
  agent_max_exchanges: number;
  location_phone: string | null;
  practice_number: string | null;
  updated_at: Date;
}

const TABLE = 'location_conversation_settings';

const DEFAULTS: Omit<LocationConversationSettings, 'location_id' | 'updated_at'> = {
  inactivity_days: 30,
  agent_mode_enabled: false,
  agent_max_exchanges: 3,
  location_phone: null,
  practice_number: null,
};

export async function findByLocationId(
  db: Knex,
  locationId: string,
): Promise<LocationConversationSettings | null> {
  const row = await db(TABLE).where({ location_id: locationId }).first();
  return (row as LocationConversationSettings) ?? null;
}

export async function upsert(
  db: Knex,
  locationId: string,
  data: Partial<{
    inactivity_days: number;
    agent_mode_enabled: boolean;
    agent_max_exchanges: number;
    location_phone: string | null;
    practice_number: string | null;
  }>,
): Promise<LocationConversationSettings> {
  const [row] = await db(TABLE)
    .insert({
      location_id: locationId,
      ...DEFAULTS,
      ...data,
      updated_at: new Date(),
    })
    .onConflict('location_id')
    .merge({
      ...data,
      updated_at: new Date(),
    })
    .returning('*');
  return row as LocationConversationSettings;
}

export async function getEffectiveSettings(
  db: Knex,
  locationId: string,
): Promise<LocationConversationSettings> {
  const row = await findByLocationId(db, locationId);
  if (row) return row;
  return {
    location_id: locationId,
    ...DEFAULTS,
    updated_at: new Date(),
  };
}
