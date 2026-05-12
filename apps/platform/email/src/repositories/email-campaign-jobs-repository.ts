import { Type, type Static } from '@sinclair/typebox';
import type { Knex } from '../db.js';

export const EmailCampaignJobSchema = Type.Object({
  id: Type.String(),
  job_ref: Type.Union([Type.String(), Type.Null()]),
  location_id: Type.String(),
  entity_type: Type.Union([Type.String(), Type.Null()]),
  entity_id: Type.Union([Type.String(), Type.Null()]),
  template_id: Type.String(),
  subject_template: Type.String(),
  domain_id: Type.String(),
  scheduled_for: Type.Union([Type.String(), Type.Null()]),
  spam_score: Type.Union([Type.Number(), Type.Null()]),
  spam_issues: Type.Union([Type.Any(), Type.Null()]),
  status: Type.String(),
  total_recipients: Type.Integer(),
  sent_count: Type.Integer(),
  failed_count: Type.Integer(),
  created_by: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  started_at: Type.Union([Type.String(), Type.Null()]),
  completed_at: Type.Union([Type.String(), Type.Null()]),
});

export type EmailCampaignJob = Static<typeof EmailCampaignJobSchema>;

export class EmailCampaignJobsRepository {
  constructor(private readonly db: Knex) {}

  async create(data: {
    job_ref: string;
    location_id: string;
    entity_type?: string | null;
    entity_id?: string | null;
    template_id: string;
    subject_template: string;
    domain_id: string;
    scheduled_for?: string | null;
    created_by?: string | null;
  }): Promise<EmailCampaignJob> {
    const [row] = await this.db('email_campaign_jobs').insert(data).returning('*');
    return row as EmailCampaignJob;
  }

  async findById(id: string): Promise<EmailCampaignJob | null> {
    const row = await this.db('email_campaign_jobs').where({ id }).first();
    return row ?? null;
  }

  async findByJobRef(jobRef: string): Promise<EmailCampaignJob | null> {
    const row = await this.db('email_campaign_jobs').where({ job_ref: jobRef }).first();
    return row ?? null;
  }

  async updateSpamScore(id: string, spamScore: number, spamIssues: unknown): Promise<void> {
    await this.db('email_campaign_jobs').where({ id }).update({
      spam_score: spamScore,
      spam_issues: spamIssues,
    });
  }

  async setSpamCheckFailed(id: string, spamScore: number, spamIssues: unknown): Promise<void> {
    await this.db('email_campaign_jobs').where({ id }).update({
      status: 'spam_check_failed',
      spam_score: spamScore,
      spam_issues: spamIssues,
    });
  }

  async setFailed(id: string, error: string): Promise<void> {
    await this.db('email_campaign_jobs').where({ id }).update({
      status: 'failed',
      error,
    });
  }

  async setProcessing(id: string, totalRecipients: number): Promise<void> {
    await this.db('email_campaign_jobs').where({ id }).update({
      status: 'processing',
      started_at: this.db.fn.now(),
      total_recipients: totalRecipients,
    });
  }

  async cancel(id: string): Promise<void> {
    await this.db('email_campaign_jobs').where({ id }).update({
      status: 'cancelled',
    });
  }

  async incrementSentCount(id: string): Promise<void> {
    await this.db('email_campaign_jobs').where({ id }).increment('sent_count', 1);
  }

  async incrementFailedCount(id: string): Promise<void> {
    await this.db('email_campaign_jobs').where({ id }).increment('failed_count', 1);
  }

  async attemptCompletion(id: string, terminalStatus: string): Promise<boolean> {
    const result = await this.db.raw(
      `UPDATE email_campaign_jobs
       SET status = ?, completed_at = now()
       WHERE id = ?
         AND sent_count + failed_count = total_recipients
         AND status = 'processing'
       RETURNING id`,
      [terminalStatus, id],
    );
    return (result.rows?.length ?? 0) > 0;
  }

  async findProcessingJobs(): Promise<EmailCampaignJob[]> {
    return this.db('email_campaign_jobs').where({ status: 'processing' }).select('*');
  }
}
