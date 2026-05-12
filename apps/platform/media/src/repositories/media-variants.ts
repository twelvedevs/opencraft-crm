import type { Knex } from 'knex';

const TABLE = 'platform_media.media_variants';

export interface MediaVariant {
  id: string;
  file_id: string;
  variant: 'medium' | 'thumb';
  s3_key: string;
  width_px: number;
  size_bytes: string;
  created_at: Date;
}

export async function insertVariant(
  knex: Knex,
  data: {
    file_id: string;
    variant: 'medium' | 'thumb';
    s3_key: string;
    width_px: number;
    size_bytes: number;
  },
): Promise<void> {
  await knex(TABLE)
    .insert(data)
    .onConflict(['file_id', 'variant'])
    .ignore();
}

export async function findByFileId(
  knex: Knex,
  file_id: string,
): Promise<MediaVariant[]> {
  const rows = await knex(TABLE).where({ file_id });
  return rows as MediaVariant[];
}
