import type { Knex } from 'knex';

const SCHEMA = 'platform_templates';
const TEMPLATES = `${SCHEMA}.templates`;
const TEMPLATE_VERSIONS = `${SCHEMA}.template_versions`;

export interface TemplateRow {
  id: string;
  name: string;
  channel: string;
  status: string;
  active_version: number | null;
  current_version: number;
  created_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface TemplateVersionRow {
  id: string;
  template_id: string;
  version: number;
  body_text: string | null;
  subject: string | null;
  body_html: string | null;
  body_unlayer: unknown | null;
  created_by: string | null;
  created_at: string;
}

export interface ListOpts {
  channel?: string;
  status?: string;
  sort?: 'created_at' | 'updated_at';
  order?: 'asc' | 'desc';
  limit?: number;
  offset?: number;
}

export class TemplatesRepo {
  constructor(private readonly db: Knex) {}

  async findById(id: string): Promise<TemplateRow | null> {
    const row = await this.db(TEMPLATES).where({ id }).first();
    return (row as TemplateRow | undefined) ?? null;
  }

  async findByName(name: string): Promise<TemplateRow | null> {
    const row = await this.db(TEMPLATES).where({ name }).first();
    return (row as TemplateRow | undefined) ?? null;
  }

  async list(opts: ListOpts): Promise<{ rows: TemplateRow[]; total: number }> {
    const { channel, status, sort = 'updated_at', order = 'desc', limit, offset } = opts;

    const applyFilters = (q: Knex.QueryBuilder) => {
      if (channel !== undefined) q.where('channel', channel);
      if (status !== undefined) q.where('status', status);
      return q;
    };

    const countResult = await applyFilters(this.db(TEMPLATES).clone()).count('id as cnt').first();
    const total = parseInt(String((countResult as { cnt: string | number } | undefined)?.cnt ?? 0), 10);

    const dataQuery = applyFilters(this.db(TEMPLATES).clone()).orderBy(sort, order);
    if (limit !== undefined) dataQuery.limit(limit);
    if (offset !== undefined) dataQuery.offset(offset);

    const rows = (await dataQuery.select('*')) as TemplateRow[];
    return { rows, total };
  }

  async create(data: { name: string; channel: string; created_by?: string | null }): Promise<TemplateRow> {
    return this.db.transaction(async (trx) => {
      const [template] = (await trx(TEMPLATES)
        .insert({
          name: data.name,
          channel: data.channel,
          created_by: data.created_by ?? null,
        })
        .returning('*')) as TemplateRow[];

      await trx(TEMPLATE_VERSIONS).insert({
        template_id: template.id,
        version: 1,
        body_text: null,
        subject: null,
        body_html: null,
        body_unlayer: null,
        created_by: data.created_by ?? null,
      });

      return template;
    });
  }

  async findVersionContent(templateId: string, version: number): Promise<TemplateVersionRow | null> {
    const row = await this.db(TEMPLATE_VERSIONS)
      .where({ template_id: templateId, version })
      .first();
    return (row as TemplateVersionRow | undefined) ?? null;
  }

  async updateVersionInPlace(
    templateId: string,
    version: number,
    data: Partial<Pick<TemplateVersionRow, 'body_text' | 'subject' | 'body_html' | 'body_unlayer'>>,
  ): Promise<void> {
    await this.db(TEMPLATE_VERSIONS)
      .where({ template_id: templateId, version })
      .update(data);
  }

  async insertNewVersion(data: {
    template_id: string;
    version: number;
    body_text?: string | null;
    subject?: string | null;
    body_html?: string | null;
    body_unlayer?: unknown | null;
    created_by?: string | null;
  }): Promise<void> {
    await this.db(TEMPLATE_VERSIONS).insert({
      template_id: data.template_id,
      version: data.version,
      body_text: data.body_text ?? null,
      subject: data.subject ?? null,
      body_html: data.body_html ?? null,
      body_unlayer: data.body_unlayer ?? null,
      created_by: data.created_by ?? null,
    });
  }

  async disable(id: string): Promise<TemplateRow | null> {
    const rows = (await this.db(TEMPLATES)
      .where({ id })
      .update({
        status: 'disabled',
        updated_at: this.db.fn.now(),
      })
      .returning('*')) as TemplateRow[];
    return rows[0] ?? null;
  }

  async activate(id: string): Promise<TemplateRow | null> {
    const rows = (await this.db(TEMPLATES)
      .where({ id })
      .update({
        active_version: this.db.ref('current_version'),
        status: 'active',
        updated_at: this.db.fn.now(),
      })
      .returning('*')) as TemplateRow[];
    return rows[0] ?? null;
  }

  async updateTemplateGroup(
    id: string,
    data: Partial<Pick<TemplateRow, 'name' | 'status' | 'active_version' | 'current_version' | 'updated_at'>>,
  ): Promise<TemplateRow> {
    const updateData = {
      ...data,
      updated_at: data.updated_at ?? this.db.fn.now(),
    };

    const [row] = (await this.db(TEMPLATES)
      .where({ id })
      .update(updateData)
      .returning('*')) as TemplateRow[];

    return row;
  }
}
