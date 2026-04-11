import type { Knex } from 'knex';
import type { Import } from '../types.js';

const TABLE = 'crm_imports.imports';

export class ImportRepository {
  constructor(private db: Knex) {}

  async create(data: Partial<Import>): Promise<Import> {
    const [row] = await this.db(TABLE).insert(data).returning('*');
    return row as Import;
  }

  async findById(id: string): Promise<Import | undefined> {
    const row = await this.db(TABLE).where({ id }).first();
    return row as Import | undefined;
  }

  async update(id: string, fields: Partial<Import>): Promise<Import> {
    const [row] = await this.db(TABLE)
      .where({ id })
      .update({ ...fields, updated_at: this.db.fn.now() })
      .returning('*');
    return row as Import;
  }

  async listByLocation(
    locationId: string,
    filters: { import_type?: string; status?: string },
    cursor?: string,
    limit = 50,
  ): Promise<{ data: Import[]; nextCursor: string | null }> {
    let query = this.db(TABLE)
      .where({ location_id: locationId })
      .orderBy('created_at', 'desc')
      .limit(limit);

    if (filters.import_type) {
      query = query.where('import_type', filters.import_type);
    }
    if (filters.status) {
      query = query.where('status', filters.status);
    }
    if (cursor) {
      query = query.where('created_at', '<', cursor);
    }

    const rows = (await query) as Import[];
    const nextCursor =
      rows.length === limit
        ? (rows[rows.length - 1].created_at as unknown as string)
        : null;

    return { data: rows, nextCursor };
  }
}
