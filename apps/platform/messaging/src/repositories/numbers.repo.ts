import { Type, type Static } from '@sinclair/typebox';
import type { Knex } from '../db.js';

export const NumberSchema = Type.Object({
  id: Type.String(),
  location_id: Type.String(),
  channel: Type.String(),
  phone_number: Type.String(),
  friendly_name: Type.Union([Type.String(), Type.Null()]),
  active: Type.Boolean(),
  rate_limit_mps: Type.Integer(),
  created_at: Type.String(),
});

export type Number = Static<typeof NumberSchema>;

export class NumbersRepository {
  constructor(private readonly db: Knex) {}

  async findById(id: string): Promise<Number | null> {
    const row = await this.db('messaging_numbers').where({ id }).first();
    return row ?? null;
  }

  async findByLocationAndChannel(locationId: string, channel: string): Promise<Number | null> {
    const row = await this.db('messaging_numbers')
      .where({ location_id: locationId, channel, active: true })
      .first();
    return row ?? null;
  }

  async findByPhoneNumber(phoneNumber: string): Promise<Number | null> {
    const row = await this.db('messaging_numbers')
      .where({ phone_number: phoneNumber })
      .first();
    return row ?? null;
  }

  async findAll(filters?: { location_id?: string; channel?: string; active?: boolean }): Promise<Number[]> {
    const query = this.db('messaging_numbers').select('*');
    if (filters?.location_id) query.where({ location_id: filters.location_id });
    if (filters?.channel) query.where({ channel: filters.channel });
    if (filters?.active !== undefined) query.where({ active: filters.active });
    return query;
  }

  async create(data: {
    location_id: string;
    channel: string;
    phone_number: string;
    friendly_name?: string;
    rate_limit_mps?: number;
  }): Promise<Number> {
    const [row] = await this.db('messaging_numbers').insert(data).returning('*');
    return row as Number;
  }

  async deactivate(id: string): Promise<void> {
    await this.db('messaging_numbers').where({ id }).update({ active: false });
  }

  async delete(id: string): Promise<void> {
    await this.db('messaging_numbers').where({ id }).delete();
  }
}
