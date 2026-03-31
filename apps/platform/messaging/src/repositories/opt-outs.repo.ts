import { Type, type Static } from '@sinclair/typebox';
import type { Knex } from '../db.js';

export const OptOutSchema = Type.Object({
  phone_number: Type.String(),
  opted_out_at: Type.String(),
  source: Type.String(),
});

export type OptOut = Static<typeof OptOutSchema>;

export class OptOutsRepository {
  constructor(private readonly db: Knex) {}

  async findByPhone(phone: string): Promise<OptOut | null> {
    const row = await this.db('messaging_opt_outs').where({ phone_number: phone }).first();
    return row ?? null;
  }

  async create(phone: string, source: string): Promise<OptOut> {
    const [row] = await this.db('messaging_opt_outs')
      .insert({ phone_number: phone, source })
      .onConflict('phone_number')
      .ignore()
      .returning('*');
    // If conflict (already exists), fetch existing
    if (!row) {
      return (await this.findByPhone(phone))!;
    }
    return row as OptOut;
  }

  async delete(phone: string): Promise<void> {
    await this.db('messaging_opt_outs').where({ phone_number: phone }).delete();
  }

  async isOptedOut(phone: string): Promise<boolean> {
    const row = await this.db('messaging_opt_outs').where({ phone_number: phone }).first();
    return !!row;
  }
}
