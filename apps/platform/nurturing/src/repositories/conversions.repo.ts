import type { Knex } from 'knex';

const SCHEMA = 'platform_nurturing';
const CONVERSIONS_TABLE = `${SCHEMA}.sequence_conversions`;

export class ConversionsRepository {
  constructor(private db: Knex) {}

  async findByEnrollmentId(enrollmentId: string): Promise<{ id: string } | undefined> {
    const row = await this.db(CONVERSIONS_TABLE)
      .select('id')
      .where({ enrollment_id: enrollmentId })
      .limit(1)
      .first();
    return row as { id: string } | undefined;
  }

  async insert(row: {
    id: string;
    enrollment_id: string;
    sequence_id: string;
    ab_variant: string | null;
    entity_type: string;
    entity_id: string;
    event_type: string;
    converted_at: Date;
  }): Promise<void> {
    await this.db(CONVERSIONS_TABLE).insert(row).onConflict('enrollment_id').ignore();
  }
}
