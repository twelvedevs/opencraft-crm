import type { Knex } from 'knex';
import type { ImportRow } from '../types.js';

const TABLE = 'crm_imports.import_rows';

export class ImportRowRepository {
  constructor(private db: Knex) {}

  async batchInsert(rows: Partial<ImportRow>[]): Promise<void> {
    if (rows.length === 0) return;
    await this.db(TABLE).insert(rows);
  }

  async findByImportId(
    importId: string,
    status?: string,
    cursor?: number,
    limit = 50,
  ): Promise<{ data: ImportRow[]; nextCursor: number | null }> {
    let query = this.db(TABLE)
      .where({ import_id: importId })
      .orderBy('row_number', 'asc')
      .limit(limit);

    if (status) {
      query = query.where('status', status);
    }
    if (cursor != null) {
      query = query.where('row_number', '>', cursor);
    }

    const rows = (await query) as ImportRow[];
    const nextCursor =
      rows.length === limit ? rows[rows.length - 1].row_number : null;

    return { data: rows, nextCursor };
  }

  async update(id: string, fields: Partial<ImportRow>): Promise<ImportRow> {
    const [row] = await this.db(TABLE)
      .where({ id })
      .update({ ...fields, updated_at: this.db.fn.now() })
      .returning('*');
    return row as ImportRow;
  }

  async findMatchedByImportId(importId: string): Promise<ImportRow[]> {
    return (await this.db(TABLE)
      .where({ import_id: importId, status: 'matched' })
      .orderBy('row_number', 'asc')) as ImportRow[];
  }

  async findExecutedByImportIdDesc(importId: string): Promise<ImportRow[]> {
    return (await this.db(TABLE)
      .where({ import_id: importId, status: 'executed' })
      .orderBy('row_number', 'desc')) as ImportRow[];
  }

  async findByImportIdAndStatus(
    importId: string,
    statuses: string[],
  ): Promise<ImportRow[]> {
    return (await this.db(TABLE)
      .where({ import_id: importId })
      .whereIn('status', statuses)) as ImportRow[];
  }
}
