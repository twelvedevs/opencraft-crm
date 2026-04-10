import type { Knex } from 'knex';
import type { ImportRepository } from '../repositories/import.repo.js';
import type { ImportRowRepository } from '../repositories/import-row.repo.js';
import type { ColumnMappingRepository } from '../repositories/column-mapping.repo.js';
import type { Import } from '../types.js';

export class ImportServiceError extends Error {
  constructor(
    public statusCode: number,
    public body: { error: string },
  ) {
    super(body.error);
    this.name = 'ImportServiceError';
  }
}

export class ImportService {
  constructor(
    private importRepo: ImportRepository,
    private importRowRepo: ImportRowRepository,
    private columnMappingRepo: ColumnMappingRepository,
    private db: Knex,
  ) {}

  async createImport(data: {
    locationId: string;
    importType: string;
    uploadedBy: string;
    fileName: string;
    fileKey: string;
    importId: string;
  }): Promise<Import> {
    return this.importRepo.create({
      id: data.importId,
      location_id: data.locationId,
      import_type: data.importType,
      uploaded_by: data.uploadedBy,
      file_name: data.fileName,
      file_key: data.fileKey,
      status: 'uploading',
    });
  }

  async getImport(id: string): Promise<Import> {
    const record = await this.importRepo.findById(id);
    if (!record) {
      throw new ImportServiceError(404, { error: 'import_not_found' });
    }
    return record;
  }

  async listImports(
    locationId: string,
    filters: { import_type?: string; status?: string },
    cursor?: string,
  ): Promise<{ data: Import[]; nextCursor: string | null }> {
    return this.importRepo.listByLocation(locationId, filters, cursor);
  }

  async confirmImport(
    id: string,
    columnMapping: Record<string, string>,
    uploadedBy: string,
  ): Promise<Import> {
    const record = await this.getImport(id);
    if (record.status !== 'preview_ready') {
      throw new ImportServiceError(409, { error: 'import_status_not_preview_ready' });
    }
    await this.columnMappingRepo.upsert(record.import_type, columnMapping, uploadedBy);
    return this.importRepo.update(id, { column_mapping: columnMapping });
  }

  async cancelImport(id: string): Promise<Import> {
    const record = await this.getImport(id);
    if (record.status !== 'preview_ready') {
      throw new ImportServiceError(409, { error: 'import_status_not_preview_ready' });
    }
    return this.importRepo.update(id, { status: 'cancelled' });
  }

  async initiateUndo(id: string): Promise<Import> {
    const result = await this.db.raw(
      `UPDATE crm_imports.imports SET status = 'undoing', updated_at = now() WHERE id = ? AND status = 'completed' AND undo_deadline > now() RETURNING *`,
      [id],
    );

    if (result.rows.length > 0) {
      return result.rows[0] as Import;
    }

    // No row updated — figure out why
    const existing = await this.db.raw(
      `SELECT status, undo_deadline FROM crm_imports.imports WHERE id = ?`,
      [id],
    );

    if (existing.rows.length === 0) {
      throw new ImportServiceError(404, { error: 'import_not_found' });
    }

    const row = existing.rows[0] as { status: string; undo_deadline: Date | null };

    if (row.undo_deadline && new Date(row.undo_deadline) <= new Date()) {
      throw new ImportServiceError(422, { error: 'undo_window_expired' });
    }

    throw new ImportServiceError(409, { error: `import_status_is_${row.status}` });
  }
}
