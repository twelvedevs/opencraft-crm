import { randomUUID } from 'node:crypto';
import type { Knex } from '../db.js';

export class EmailSendClicksRepository {
  constructor(private readonly db: Knex) {}

  async insert(sendId: string, url: string): Promise<void> {
    await this.db('email_send_clicks').insert({
      id: randomUUID(),
      send_id: sendId,
      url,
      clicked_at: this.db.fn.now(),
    });
  }
}
