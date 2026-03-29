import { Type, type Static } from '@sinclair/typebox';
import type { Knex } from '../db.js';

export const EmailCampaignRecipientSchema = Type.Object({
  id: Type.String(),
  job_id: Type.String(),
  to_email: Type.String(),
  context: Type.Any(),
  sendgrid_message_id: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  attempt: Type.Integer(),
  error: Type.Union([Type.String(), Type.Null()]),
  sent_at: Type.Union([Type.String(), Type.Null()]),
  delivered_at: Type.Union([Type.String(), Type.Null()]),
  opened_at: Type.Union([Type.String(), Type.Null()]),
  clicked_at: Type.Union([Type.String(), Type.Null()]),
  bounced_at: Type.Union([Type.String(), Type.Null()]),
});

export type EmailCampaignRecipient = Static<typeof EmailCampaignRecipientSchema>;

export class EmailCampaignRecipientsRepository {
  constructor(private readonly db: Knex) {}

  async bulkInsert(
    rows: Array<{ job_id: string; to_email: string; context: Record<string, unknown> }>,
  ): Promise<void> {
    await this.db('email_campaign_recipients').insert(rows);
  }

  async findById(id: string): Promise<EmailCampaignRecipient | null> {
    const row = await this.db('email_campaign_recipients').where({ id }).first();
    return row ?? null;
  }

  async findPendingByJobId(jobId: string): Promise<EmailCampaignRecipient[]> {
    return this.db('email_campaign_recipients')
      .where({ job_id: jobId, status: 'pending' })
      .select('*');
  }

  async markSent(id: string, sendgridMessageId: string): Promise<void> {
    await this.db('email_campaign_recipients').where({ id }).update({
      status: 'sent',
      sendgrid_message_id: sendgridMessageId,
      sent_at: this.db.fn.now(),
    });
  }

  async markFailed(id: string, error: string): Promise<void> {
    await this.db('email_campaign_recipients').where({ id }).update({
      status: 'failed',
      error,
    });
  }

  async markBounced(id: string): Promise<void> {
    await this.db('email_campaign_recipients').where({ id }).update({
      status: 'bounced',
      bounced_at: this.db.fn.now(),
    });
  }

  async incrementAttempt(id: string): Promise<void> {
    await this.db('email_campaign_recipients').where({ id }).increment('attempt', 1);
  }

  async findByJobIdPaginated(
    jobId: string,
    options: { status?: string; page: number; pageSize: number },
  ): Promise<{ recipients: EmailCampaignRecipient[]; total: number }> {
    const { status, page, pageSize } = options;
    const offset = (page - 1) * pageSize;

    const query = this.db('email_campaign_recipients').where({ job_id: jobId });
    const countQuery = this.db('email_campaign_recipients').where({ job_id: jobId });

    if (status !== undefined) {
      query.where({ status });
      countQuery.where({ status });
    }

    const [recipients, countResult] = await Promise.all([
      query.select('*').limit(pageSize).offset(offset),
      countQuery.count<{ count: string }[]>('* as count').first(),
    ]);

    return {
      recipients: recipients as EmailCampaignRecipient[],
      total: parseInt(countResult?.count ?? '0', 10),
    };
  }
}
