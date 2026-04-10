import type { Knex } from 'knex';
import type { ColumnMapping } from '../types.js';

const TABLE = 'crm_imports.column_mappings';

export class ColumnMappingRepository {
  constructor(private db: Knex) {}

  async findByType(importType: string): Promise<ColumnMapping | undefined> {
    const row = await this.db(TABLE).where({ import_type: importType }).first();
    return row as ColumnMapping | undefined;
  }

  async upsert(
    importType: string,
    mapping: Record<string, string>,
    updatedBy: string,
  ): Promise<ColumnMapping> {
    const [row] = await this.db(TABLE)
      .insert({
        import_type: importType,
        mapping: JSON.stringify(mapping),
        updated_by: updatedBy,
        updated_at: this.db.fn.now(),
      })
      .onConflict('import_type')
      .merge({
        mapping: JSON.stringify(mapping),
        updated_by: updatedBy,
        updated_at: this.db.fn.now(),
      })
      .returning('*');
    return row as ColumnMapping;
  }
}
