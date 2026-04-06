import type { Knex } from 'knex';
import * as tagRepository from '../repositories/tag-repository.js';
import type { Tag } from '../repositories/tag-repository.js';

export type { Tag };

export async function listTags(db: Knex, locationId?: string): Promise<Tag[]> {
  return tagRepository.findTagsByLocation(db, locationId ?? null);
}

export async function createTag(
  db: Knex,
  data: { name: string; location_id: string | null; created_by: string },
): Promise<Tag> {
  return tagRepository.createTag(db, data);
}

export async function deleteTag(db: Knex, id: string): Promise<void> {
  return tagRepository.deleteTag(db, id);
}

export async function applyTagToLead(
  db: Knex,
  leadId: string,
  tagId: string,
  appliedBy: string,
): Promise<void> {
  return tagRepository.applyTagToLead(db, leadId, tagId, appliedBy);
}

export async function removeTagFromLead(db: Knex, leadId: string, tagId: string): Promise<void> {
  return tagRepository.removeTagFromLead(db, leadId, tagId);
}
