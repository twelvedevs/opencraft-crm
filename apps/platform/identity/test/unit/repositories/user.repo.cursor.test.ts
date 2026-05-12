import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock pg Pool
const queryMock = vi.fn();

vi.mock('pg', () => ({
  default: {
    Pool: vi.fn(() => ({ query: queryMock })),
  },
}));

import { listUsers } from '../../../src/repositories/user.repo.js';
import type { Pool } from 'pg';

const mockPool = { query: queryMock } as unknown as Pool;

const makeUser = (overrides: Partial<Record<string, unknown>> = {}) => ({
  id: 'user-uuid-1',
  provider_user_id: 'prov-1',
  email: 'test@example.com',
  name: 'Test User',
  role: 'call_center_agent',
  status: 'active',
  force_password_reset: false,
  created_by: null,
  created_at: new Date('2024-01-15T10:00:00.000Z'),
  updated_at: new Date('2024-01-15T10:00:00.000Z'),
  ...overrides,
});

describe('user.repo listUsers cursor pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null nextCursor when result count is exactly at the limit', async () => {
    const users = Array.from({ length: 50 }, (_, i) =>
      makeUser({ id: `user-${i}`, email: `user${i}@test.com` }),
    );
    queryMock.mockResolvedValue({ rows: users }); // 50 rows returned (limit+1 was 51, so <51)

    const result = await listUsers(mockPool, { limit: 50 });

    expect(result.rows).toHaveLength(50);
    expect(result.nextCursor).toBeNull();
  });

  it('returns a base64 nextCursor when there are more rows than the limit', async () => {
    const limit = 2;
    const users = Array.from({ length: 3 }, (_, i) =>
      makeUser({ id: `user-${i}`, email: `user${i}@test.com` }),
    );
    queryMock.mockResolvedValue({ rows: users }); // 3 rows for limit+1=3 query

    const result = await listUsers(mockPool, { limit });

    expect(result.rows).toHaveLength(2); // only limit rows returned
    expect(result.nextCursor).not.toBeNull();

    // Cursor should decode to { created_at, id } of the last returned row
    const decoded = JSON.parse(Buffer.from(result.nextCursor!, 'base64').toString());
    expect(decoded).toHaveProperty('id', 'user-1'); // last of the 2 returned rows
    expect(decoded).toHaveProperty('created_at');
  });

  it('cursor encodes created_at as ISO string for stable cross-service serialization', async () => {
    const ts = new Date('2024-03-15T14:30:00.000Z');
    const user = makeUser({ id: 'user-a', created_at: ts });
    queryMock.mockResolvedValue({ rows: [user, user] }); // >limit to trigger cursor

    const result = await listUsers(mockPool, { limit: 1 });

    const decoded = JSON.parse(Buffer.from(result.nextCursor!, 'base64').toString());
    expect(typeof decoded.created_at).toBe('string');
    // Verify the serialized form is parseable back to the same timestamp
    expect(new Date(decoded.created_at).getTime()).toBe(ts.getTime());
  });

  it('includes cursor WHERE clause when cursor param is provided', async () => {
    const cursor = Buffer.from(
      JSON.stringify({ created_at: '2024-01-10T00:00:00.000Z', id: 'user-prev' }),
    ).toString('base64');

    queryMock.mockResolvedValue({ rows: [] });

    await listUsers(mockPool, { cursor });

    const sql: string = queryMock.mock.calls[0][0];
    expect(sql).toContain('(created_at, id) >');
  });

  it('applies role and status filters in WHERE clause', async () => {
    queryMock.mockResolvedValue({ rows: [] });

    await listUsers(mockPool, { role: 'call_center_agent', status: 'active' });

    const sql: string = queryMock.mock.calls[0][0];
    const params: unknown[] = queryMock.mock.calls[0][1];
    expect(sql).toContain('role =');
    expect(sql).toContain('status =');
    expect(params).toContain('call_center_agent');
    expect(params).toContain('active');
  });
});
