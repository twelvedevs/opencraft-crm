import type { Knex } from 'knex';

export interface Tag {
  id: string;
  name: string;
  location_id: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

export interface LeadTag {
  lead_id: string;
  tag_id: string;
  applied_by: string;
  applied_at: string;
}

const TAGS_TABLE = 'crm_leads.tags';
const LEAD_TAGS_TABLE = 'crm_leads.lead_tags';

export function findTagsByLocation(db: Knex, locationId: string | null): Promise<Tag[]> {
  return db(TAGS_TABLE)
    .where(function (this: Knex.QueryBuilder) {
      if (locationId) {
        this.where({ location_id: locationId }).orWhereNull('location_id');
      } else {
        this.whereNull('location_id');
      }
    })
    .then((rows) => rows as Tag[]);
}

export function findTagById(db: Knex, id: string): Promise<Tag | null> {
  return db(TAGS_TABLE)
    .where({ id })
    .first()
    .then((row) => (row as Tag) ?? null);
}

export function createTag(
  db: Knex,
  data: { name: string; location_id: string | null; created_by: string },
): Promise<Tag> {
  return db(TAGS_TABLE)
    .insert(data)
    .returning('*')
    .then((rows) => rows[0] as Tag);
}

export function deleteTag(db: Knex, id: string): Promise<void> {
  return db(TAGS_TABLE)
    .where({ id })
    .delete()
    .then(() => undefined);
}

export function applyTagToLead(
  db: Knex,
  leadId: string,
  tagId: string,
  appliedBy: string,
): Promise<void> {
  return db(LEAD_TAGS_TABLE)
    .insert({
      lead_id: leadId,
      tag_id: tagId,
      applied_by: appliedBy,
      applied_at: db.fn.now(),
    })
    .onConflict(['lead_id', 'tag_id'])
    .ignore()
    .then(() => undefined);
}

export function removeTagFromLead(db: Knex, leadId: string, tagId: string): Promise<void> {
  return db(LEAD_TAGS_TABLE)
    .where({ lead_id: leadId, tag_id: tagId })
    .delete()
    .then(() => undefined);
}

export function findTagsByLeadId(db: Knex, leadId: string): Promise<Tag[]> {
  return db(TAGS_TABLE)
    .join(LEAD_TAGS_TABLE, `${LEAD_TAGS_TABLE}.tag_id`, `${TAGS_TABLE}.id`)
    .where(`${LEAD_TAGS_TABLE}.lead_id`, leadId)
    .select(`${TAGS_TABLE}.*`)
    .then((rows) => rows as Tag[]);
}
