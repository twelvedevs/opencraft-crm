import type { Knex } from 'knex';

const SCHEMA = 'platform_notifications';
const NOTIFICATIONS = `${SCHEMA}.notifications`;
const READS = `${SCHEMA}.notification_reads`;

export interface NotificationRow {
  id: string;
  seq: string;
  channel: string;
  title: string;
  body: string | null;
  payload: unknown | null;
  expires_at: Date;
  created_at: Date;
  read: boolean;
}

interface InsertData {
  id: string;
  channel: string;
  title: string;
  body?: string;
  payload?: unknown;
  expires_at: Date;
}

interface FindHistoryParams {
  channels: string[];
  userId: string;
  unread?: boolean;
  before?: string;
  limit?: number;
}

interface FindHistoryResult {
  rows: NotificationRow[];
  nextCursor: string | null;
  totalUnread: number;
}

interface FindMissedParams {
  channels: string[];
  afterSeq: string | number;
  limit: number;
}

interface FindMissedResult {
  rows: NotificationRow[];
  truncated: boolean;
}

function encodeCursor(createdAt: Date | string, id: string): string {
  const ts = createdAt instanceof Date ? createdAt.toISOString() : createdAt;
  return Buffer.from(JSON.stringify({ created_at: ts, id })).toString('base64');
}

function decodeCursor(cursor: string): { created_at: string; id: string } | null {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64').toString('utf-8')) as unknown;
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      'created_at' in parsed &&
      'id' in parsed
    ) {
      return parsed as { created_at: string; id: string };
    }
    return null;
  } catch {
    return null;
  }
}

export class NotificationsRepo {
  constructor(private readonly db: Knex) {}

  async insert(data: InsertData): Promise<{ id: string; seq: string }> {
    const [row] = await this.db(NOTIFICATIONS)
      .insert({
        id: data.id,
        channel: data.channel,
        title: data.title,
        body: data.body ?? null,
        payload: data.payload !== undefined ? JSON.stringify(data.payload) : null,
        expires_at: data.expires_at,
      })
      .returning(['id', 'seq']);
    return row as { id: string; seq: string };
  }

  async findHistory(params: FindHistoryParams): Promise<FindHistoryResult> {
    const { channels, userId, unread = false, before, limit = 50 } = params;

    // totalUnread: all unread for this user in these channels (ignores pagination)
    const unreadCountResult = await this.db(`${NOTIFICATIONS} as n`)
      .leftJoin(`${READS} as r`, function () {
        this.on('r.notification_id', '=', 'n.id').andOnVal('r.user_id', userId);
      })
      .whereIn('n.channel', channels)
      .where('n.expires_at', '>', this.db.fn.now())
      .whereNull('r.notification_id')
      .count('n.id as cnt')
      .first();

    const totalUnread = parseInt(
      String((unreadCountResult as { cnt: string | number } | undefined)?.cnt ?? 0),
      10,
    );

    // Main paginated query
    const query = this.db(`${NOTIFICATIONS} as n`)
      .leftJoin(`${READS} as r`, function () {
        this.on('r.notification_id', '=', 'n.id').andOnVal('r.user_id', userId);
      })
      .whereIn('n.channel', channels)
      .where('n.expires_at', '>', this.db.fn.now())
      .select(
        'n.id',
        'n.seq',
        'n.channel',
        'n.title',
        'n.body',
        'n.payload',
        'n.expires_at',
        'n.created_at',
        this.db.raw('(r.notification_id IS NOT NULL) as "read"'),
      )
      .orderBy('n.created_at', 'desc')
      .orderBy('n.id', 'desc')
      .limit(limit + 1);

    if (unread) {
      query.whereNull('r.notification_id');
    }

    if (before) {
      const cursor = decodeCursor(before);
      if (cursor) {
        query.where(function () {
          this.where('n.created_at', '<', cursor.created_at).orWhere(function () {
            this.where('n.created_at', '=', cursor.created_at).andWhere('n.id', '<', cursor.id);
          });
        });
      }
    }

    const rows = (await query) as NotificationRow[];
    const hasMore = rows.length > limit;
    const sliced = hasMore ? rows.slice(0, limit) : rows;
    const last = sliced[sliced.length - 1];
    const nextCursor =
      hasMore && last ? encodeCursor(last.created_at, last.id) : null;

    return { rows: sliced, nextCursor, totalUnread };
  }

  async findMissed(params: FindMissedParams): Promise<FindMissedResult> {
    const { channels, afterSeq, limit } = params;

    const rows = (await this.db(NOTIFICATIONS)
      .whereIn('channel', channels)
      .where('seq', '>', afterSeq)
      .where('expires_at', '>', this.db.fn.now())
      .orderBy('seq', 'asc')
      .limit(limit + 1)
      .select('*')) as Array<Omit<NotificationRow, 'read'>>;

    const truncated = rows.length > limit;
    const sliced = truncated ? rows.slice(0, limit) : rows;

    return {
      rows: sliced.map((r) => ({ ...r, read: false })),
      truncated,
    };
  }

  async markRead(userId: string, notificationId: string): Promise<boolean> {
    const notification = await this.db(NOTIFICATIONS)
      .where({ id: notificationId })
      .where('expires_at', '>', this.db.fn.now())
      .first();

    if (!notification) return false;

    await this.db(READS)
      .insert({ user_id: userId, notification_id: notificationId })
      .onConflict(['user_id', 'notification_id'])
      .ignore();

    return true;
  }

  async markAllRead(
    userId: string,
    channels: string[],
  ): Promise<{ ids: string[]; count: number }> {
    const unreadRows = (await this.db(`${NOTIFICATIONS} as n`)
      .leftJoin(`${READS} as r`, function () {
        this.on('r.notification_id', '=', 'n.id').andOnVal('r.user_id', userId);
      })
      .whereIn('n.channel', channels)
      .where('n.expires_at', '>', this.db.fn.now())
      .whereNull('r.notification_id')
      .select('n.id')) as Array<{ id: string }>;

    if (unreadRows.length === 0) {
      return { ids: [], count: 0 };
    }

    const ids = unreadRows.map((r) => r.id);
    const insertRows = ids.map((id) => ({ user_id: userId, notification_id: id }));

    await this.db(READS)
      .insert(insertRows)
      .onConflict(['user_id', 'notification_id'])
      .ignore();

    return { ids, count: ids.length };
  }

  async deleteExpired(): Promise<number> {
    return this.db(NOTIFICATIONS).where('expires_at', '<', this.db.fn.now()).delete();
  }
}
