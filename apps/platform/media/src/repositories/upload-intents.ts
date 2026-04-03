import type { Knex } from 'knex';

const TABLE = 'platform_media.media_upload_intents';

export interface UploadIntent {
  id: string;
  file_id: string;
  presigned_url: string;
  expires_at: Date;
  created_at: Date;
}

export async function createIntent(
  knex: Knex,
  data: {
    id: string;
    file_id: string;
    presigned_url: string;
    expires_at: Date;
  },
): Promise<UploadIntent> {
  const [row] = await knex(TABLE).insert(data).returning('*');
  return row as UploadIntent;
}

export async function findByUploadId(
  knex: Knex,
  upload_id: string,
): Promise<UploadIntent | null> {
  const row = await knex(TABLE).where({ id: upload_id }).first();
  return (row as UploadIntent) ?? null;
}

export async function deleteExpired(knex: Knex): Promise<number> {
  return knex(TABLE).where('expires_at', '<', knex.fn.now()).del();
}
