import { Type, type Static } from '@sinclair/typebox';
import type { Knex } from '../db.js';

export const EmailSendSchema = Type.Object({
  id: Type.String(),
  dedup_key: Type.Union([Type.String(), Type.Null()]),
  location_id: Type.String(),
  domain_id: Type.Union([Type.String(), Type.Null()]),
  entity_type: Type.Union([Type.String(), Type.Null()]),
  entity_id: Type.Union([Type.String(), Type.Null()]),
  to_email: Type.String(),
  subject: Type.String(),
  sendgrid_message_id: Type.Union([Type.String(), Type.Null()]),
  status: Type.String(),
  attempt: Type.Number(),
  error: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
  sent_at: Type.Union([Type.String(), Type.Null()]),
  delivered_at: Type.Union([Type.String(), Type.Null()]),
  opened_at: Type.Union([Type.String(), Type.Null()]),
  clicked_at: Type.Union([Type.String(), Type.Null()]),
  bounced_at: Type.Union([Type.String(), Type.Null()]),
});

export type EmailSend = Static<typeof EmailSendSchema>;

export class EmailSendsRepository {
  constructor(private readonly db: Knex) {}

  async findById(id: string): Promise<EmailSend | null> {
    const row = await this.db('email_sends').where({ id }).first();
    return row ?? null;
  }

  async findByDedupKey(dedupKey: string): Promise<EmailSend | null> {
    const row = await this.db('email_sends').where({ dedup_key: dedupKey }).first();
    return row ?? null;
  }

  async create(data: {
    dedup_key: string;
    location_id: string;
    domain_id: string;
    to_email: string;
    subject: string;
    entity_type?: string | null;
    entity_id?: string | null;
  }): Promise<EmailSend> {
    const [row] = await this.db('email_sends').insert(data).returning('*');
    return row as EmailSend;
  }

  async markSent(id: string, sendgridMessageId: string): Promise<void> {
    await this.db('email_sends').where({ id }).update({
      status: 'sent',
      sendgrid_message_id: sendgridMessageId,
      sent_at: this.db.fn.now(),
    });
  }

  async markFailed(id: string, errorMessage: string): Promise<void> {
    await this.db('email_sends').where({ id }).update({
      status: 'failed',
      error: errorMessage,
    });
  }

  async incrementAttempt(id: string): Promise<void> {
    await this.db('email_sends').where({ id }).increment('attempt', 1);
  }

  async findBySendgridMessageId(msgId: string): Promise<EmailSend | null> {
    const row = await this.db('email_sends').where({ sendgrid_message_id: msgId }).first();
    return row ?? null;
  }

  async markDelivered(id: string, ts: Date): Promise<void> {
    await this.db('email_sends')
      .where({ id })
      .whereIn('status', ['sent'])
      .update({ status: 'delivered', delivered_at: ts });
  }

  async markOpened(id: string, ts: Date): Promise<void> {
    await this.db('email_sends')
      .where({ id })
      .whereIn('status', ['sent', 'delivered'])
      .update({ status: 'opened', opened_at: this.db.raw('COALESCE(opened_at, ?)', [ts]) });
  }

  async markClicked(id: string, ts: Date): Promise<void> {
    await this.db('email_sends')
      .where({ id })
      .whereIn('status', ['sent', 'delivered', 'opened'])
      .update({ status: 'clicked', clicked_at: this.db.raw('COALESCE(clicked_at, ?)', [ts]) });
  }

  async markBouncedFromWebhook(id: string, ts: Date): Promise<void> {
    await this.db('email_sends')
      .where({ id })
      .whereNotIn('status', ['bounced', 'failed'])
      .update({ status: 'bounced', bounced_at: ts });
  }

  async markUnsubscribed(id: string): Promise<void> {
    await this.db('email_sends')
      .where({ id })
      .whereNotIn('status', ['unsubscribed', 'bounced', 'failed'])
      .update({ status: 'unsubscribed' });
  }

  async markSpamReported(id: string): Promise<void> {
    await this.db('email_sends')
      .where({ id })
      .whereNotIn('status', ['bounced', 'unsubscribed', 'failed'])
      .update({ status: 'bounced', bounced_at: this.db.fn.now() });
  }
}
