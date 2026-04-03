import type { Knex } from 'knex';

const TABLE = 'platform_media.media_files';

export interface MediaFile {
  id: string;
  upload_id: string;
  tier: 'public' | 'private';
  status: 'pending' | 'ready' | 'deleted';
  mime_type: string;
  original_key: string;
  original_filename: string;
  file_size_bytes: string | null;
  location_id: string | null;
  purpose: string | null;
  uploaded_by: string;
  created_at: Date;
  confirmed_at: Date | null;
  deleted_at: Date | null;
}

export async function createPending(
  knex: Knex,
  data: {
    id: string;
    upload_id: string;
    tier: 'public' | 'private';
    mime_type: string;
    original_key: string;
    original_filename: string;
    location_id?: string | null;
    purpose?: string | null;
    uploaded_by: string;
  },
): Promise<MediaFile> {
  const [row] = await knex(TABLE)
    .insert({
      ...data,
      status: 'pending',
    })
    .returning('*');
  return row as MediaFile;
}

export async function findByUploadId(
  knex: Knex,
  upload_id: string,
): Promise<MediaFile | null> {
  const row = await knex(TABLE).where({ upload_id }).first();
  return (row as MediaFile) ?? null;
}

export async function findById(
  knex: Knex,
  id: string,
): Promise<MediaFile | null> {
  const row = await knex(TABLE)
    .where({ id })
    .whereNull('deleted_at')
    .first();
  return (row as MediaFile) ?? null;
}

export async function markReady(
  knex: Knex,
  id: string,
  data: { file_size_bytes: number; confirmed_at: Date },
): Promise<void> {
  await knex(TABLE).where({ id }).update({
    status: 'ready',
    file_size_bytes: data.file_size_bytes,
    confirmed_at: data.confirmed_at,
  });
}

export async function softDelete(knex: Knex, id: string): Promise<void> {
  await knex(TABLE).where({ id }).update({ deleted_at: knex.fn.now() });
}
