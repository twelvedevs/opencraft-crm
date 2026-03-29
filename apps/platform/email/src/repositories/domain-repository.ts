import { Type, type Static } from '@sinclair/typebox';
import type { Knex } from '../db.js';

export const SendingDomainSchema = Type.Object({
  id: Type.String(),
  location_id: Type.String(),
  domain: Type.String(),
  from_name: Type.String(),
  from_email: Type.String(),
  is_verified: Type.Boolean(),
  spam_score_threshold: Type.Number(),
  sendgrid_domain_id: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  updated_at: Type.String(),
});

export type SendingDomain = Static<typeof SendingDomainSchema>;

export class DomainRepository {
  constructor(private readonly db: Knex) {}

  async findByLocationId(locationId: string): Promise<SendingDomain | null> {
    const row = await this.db('email_sending_domains')
      .where({ location_id: locationId })
      .first();
    return row ?? null;
  }

  async findById(id: string): Promise<SendingDomain | null> {
    const row = await this.db('email_sending_domains')
      .where({ id })
      .first();
    return row ?? null;
  }

  async findAll(): Promise<SendingDomain[]> {
    return this.db('email_sending_domains').select('*');
  }

  async create(data: {
    location_id: string;
    domain: string;
    from_name: string;
    from_email: string;
  }): Promise<SendingDomain> {
    const [row] = await this.db('email_sending_domains')
      .insert(data)
      .returning('*');
    return row as SendingDomain;
  }

  async updateVerified(id: string, isVerified: boolean, sendgridDomainId?: string): Promise<void> {
    const update: Record<string, unknown> = {
      is_verified: isVerified,
      updated_at: this.db.fn.now(),
    };
    if (sendgridDomainId !== undefined) {
      update['sendgrid_domain_id'] = sendgridDomainId;
    }
    await this.db('email_sending_domains').where({ id }).update(update);
  }

  async delete(id: string): Promise<void> {
    await this.db('email_sending_domains').where({ id }).delete();
  }

  async hasSentEmailsIn30Days(domainId: string): Promise<boolean> {
    const sendRow = await this.db('email_sends')
      .where('domain_id', domainId)
      .where('created_at', '>', this.db.raw("now() - interval '30 days'"))
      .first();
    if (sendRow) return true;

    const jobRow = await this.db('email_campaign_jobs')
      .where('domain_id', domainId)
      .where('created_at', '>', this.db.raw("now() - interval '30 days'"))
      .first();
    return !!jobRow;
  }
}
