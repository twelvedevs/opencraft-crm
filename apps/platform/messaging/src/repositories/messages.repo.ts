import { Type, type Static } from '@sinclair/typebox';
import type { Knex } from '../db.js';

export const MessageSchema = Type.Object({
  id: Type.String(),
  direction: Type.String(),
  to_number: Type.String(),
  from_number: Type.String(),
  body: Type.Union([Type.String(), Type.Null()]),
  media_urls: Type.Union([Type.Array(Type.String()), Type.Null()]),
  message_type: Type.String(),
  status: Type.String(),
  twilio_sid: Type.Union([Type.String(), Type.Null()]),
  dedup_key: Type.Union([Type.String(), Type.Null()]),
  error_code: Type.Union([Type.String(), Type.Null()]),
  error_message: Type.Union([Type.String(), Type.Null()]),
  sent_at: Type.Union([Type.String(), Type.Null()]),
  delivered_at: Type.Union([Type.String(), Type.Null()]),
  received_at: Type.Union([Type.String(), Type.Null()]),
  created_at: Type.String(),
});

export type Message = Static<typeof MessageSchema>;

interface Cursor {
  created_at: string;
  id: string;
}

export class MessagesRepository {
  constructor(private readonly db: Knex) {}

  async findById(id: string): Promise<Message | null> {
    const row = await this.db('messaging_messages').where({ id }).first();
    return row ?? null;
  }

  async findByTwilioSid(twilioSid: string): Promise<Message | null> {
    const row = await this.db('messaging_messages').where({ twilio_sid: twilioSid }).first();
    return row ?? null;
  }

  async findByDedupKey(dedupKey: string): Promise<Message | null> {
    const row = await this.db('messaging_messages').where({ dedup_key: dedupKey }).first();
    return row ?? null;
  }

  async create(data: Record<string, unknown>): Promise<Message> {
    const [row] = await this.db('messaging_messages').insert(data).returning('*');
    return row as Message;
  }

  async updateStatus(
    id: string,
    status: string,
    extra?: {
      twilio_sid?: string;
      error_code?: string;
      error_message?: string;
      delivered_at?: Date | string;
      sent_at?: Date | string;
    },
  ): Promise<void> {
    const update: Record<string, unknown> = { status };
    if (extra) {
      if (extra.twilio_sid !== undefined) update['twilio_sid'] = extra.twilio_sid;
      if (extra.error_code !== undefined) update['error_code'] = extra.error_code;
      if (extra.error_message !== undefined) update['error_message'] = extra.error_message;
      if (extra.delivered_at !== undefined) update['delivered_at'] = extra.delivered_at;
      if (extra.sent_at !== undefined) update['sent_at'] = extra.sent_at;
    }
    await this.db('messaging_messages').where({ id }).update(update);
  }

  async list(
    filters: {
      to_number?: string;
      from_number?: string;
      status?: string;
      from_date?: string;
      to_date?: string;
    },
    cursor?: string,
    limit: number = 50,
  ): Promise<{ data: Message[]; next_cursor: string | null; has_more: boolean }> {
    const query = this.db('messaging_messages').select('*');

    if (filters.to_number) query.where({ to_number: filters.to_number });
    if (filters.from_number) query.where({ from_number: filters.from_number });
    if (filters.status) query.where({ status: filters.status });
    if (filters.from_date) query.where('created_at', '>=', filters.from_date);
    if (filters.to_date) query.where('created_at', '<=', filters.to_date);

    if (cursor) {
      const decoded: Cursor = JSON.parse(Buffer.from(cursor, 'base64').toString('utf8'));
      query.where(function () {
        this.where('created_at', '<', decoded.created_at)
          .orWhere(function () {
            this.where('created_at', '=', decoded.created_at).andWhere('id', '<', decoded.id);
          });
      });
    }

    query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(limit + 1);

    const rows = await query;
    const hasMore = rows.length > limit;
    const data = hasMore ? rows.slice(0, limit) : rows;
    const lastRow = data[data.length - 1];
    const nextCursor = hasMore && lastRow
      ? Buffer.from(JSON.stringify({ created_at: lastRow.created_at, id: lastRow.id })).toString('base64')
      : null;

    return { data, next_cursor: nextCursor, has_more: hasMore };
  }
}
