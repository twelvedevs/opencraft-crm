import type { Knex } from 'knex';

export interface Activity {
  id: string;
  lead_id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
  source_event_id: string;
}

export interface InsertActivityData {
  lead_id: string;
  event_type: string;
  actor_type: string;
  actor_id: string | null;
  payload: Record<string, unknown>;
  occurred_at: string;
  source_event_id: string;
}

const TABLE = 'crm_leads.lead_activities';

interface ActivityCursorData {
  lastSeenOccurredAt: string;
  lastSeenId: string;
}

function decodeCursor(cursor: string): ActivityCursorData {
  const json = Buffer.from(cursor, 'base64').toString('utf-8');
  return JSON.parse(json) as ActivityCursorData;
}

function encodeCursor(data: ActivityCursorData): string {
  return Buffer.from(JSON.stringify(data)).toString('base64');
}

export async function insertActivity(db: Knex, data: InsertActivityData): Promise<string | null> {
  const rows = await db.raw(
    `INSERT INTO ${TABLE} (lead_id, event_type, actor_type, actor_id, payload, occurred_at, source_event_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source_event_id) DO NOTHING
     RETURNING id`,
    [data.lead_id, data.event_type, data.actor_type, data.actor_id, JSON.stringify(data.payload), data.occurred_at, data.source_event_id],
  );
  const insertedId: string | undefined = rows.rows?.[0]?.id;
  if (insertedId) {
    await db.raw(
      `UPDATE crm_leads.leads
       SET last_activity_at = GREATEST(COALESCE(last_activity_at, '1970-01-01'::timestamptz), ?::timestamptz),
           updated_at = now()
       WHERE id = ?`,
      [data.occurred_at, data.lead_id],
    );
  }
  return insertedId ?? null;
}

export async function listActivities(
  db: Knex,
  leadId: string,
  params: { eventTypes?: string[]; cursor?: string; limit?: number },
): Promise<{ activities: Activity[]; nextCursor: string | null }> {
  const { eventTypes, cursor, limit = 50 } = params;
  const effectiveLimit = Math.min(limit, 200);

  let query = db(TABLE).where({ lead_id: leadId });

  if (eventTypes && eventTypes.length > 0) {
    query = query.whereIn('event_type', eventTypes);
  }

  if (cursor) {
    const decoded = decodeCursor(cursor);
    query = query.whereRaw(
      `(occurred_at, id) < (?, ?)`,
      [decoded.lastSeenOccurredAt, decoded.lastSeenId],
    );
  }

  query = query
    .orderBy('occurred_at', 'desc')
    .orderBy('id', 'desc')
    .limit(effectiveLimit + 1);

  const rows = (await query) as Activity[];

  let nextCursor: string | null = null;
  if (rows.length > effectiveLimit) {
    rows.pop();
    const lastRow = rows[rows.length - 1];
    nextCursor = encodeCursor({
      lastSeenOccurredAt: lastRow.occurred_at,
      lastSeenId: lastRow.id,
    });
  }

  return { activities: rows, nextCursor };
}

export async function findLastInboundAt(db: Knex, leadId: string): Promise<Date | null> {
  const row = await db(TABLE)
    .where({ lead_id: leadId, event_type: 'inbound_message.received' })
    .orderBy('occurred_at', 'desc')
    .first('occurred_at');
  return row ? new Date(row.occurred_at as string) : null;
}

export function findBySourceEventId(db: Knex, sourceEventId: string): Promise<Activity | null> {
  return db(TABLE)
    .where({ source_event_id: sourceEventId })
    .first()
    .then((row) => (row as Activity) ?? null);
}
