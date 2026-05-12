import { randomUUID } from 'node:crypto';
import type { Knex } from '../db.js';

export class EmailRecipientClicksRepository {
  constructor(private readonly db: Knex) {}

  async insert(recipientId: string, url: string): Promise<void> {
    await this.db('email_recipient_clicks').insert({
      id: randomUUID(),
      recipient_id: recipientId,
      url,
      clicked_at: this.db.fn.now(),
    });
  }
}
