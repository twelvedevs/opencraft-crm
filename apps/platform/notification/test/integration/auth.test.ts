import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { randomUUID } from 'crypto';
import { createSecretKey } from 'crypto';
import { SignJWT } from 'jose';
import {
  createTestContext,
  makeServiceToken,
  makeUserToken,
  resetSchema,
  truncateTables,
  TEST_JWT_SECRET,
  type TestContext,
} from './helpers.js';

describe('Auth and channel validation', () => {
  let ctx: TestContext;
  const userId = randomUUID();
  const locId = randomUUID();
  const validChannel = `location:${locId}:alerts`;

  beforeAll(async () => {
    ctx = await createTestContext();
    await resetSchema(ctx.db);
  });

  afterAll(async () => {
    await ctx.close();
  });

  beforeEach(async () => {
    await truncateTables(ctx.db);
  });

  async function makeExpiredToken(): Promise<string> {
    const secretKey = createSecretKey(Buffer.from(TEST_JWT_SECRET, 'utf-8'));
    return new SignJWT({ sub: userId })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(secretKey);
  }

  // ─── /notifications/stream ────────────────────────────────────────────────

  it('GET /stream with no token returns 401', async () => {
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/notifications/stream?channels=${validChannel}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('GET /stream with expired token returns 403', async () => {
    const expiredToken = await makeExpiredToken();
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/notifications/stream?channels=${validChannel}`,
      headers: { Authorization: `Bearer ${expiredToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /stream with unknown channel pattern returns 400', async () => {
    const userToken = await makeUserToken(userId, [locId]);
    const res = await ctx.app.inject({
      method: 'GET',
      url: '/notifications/stream?channels=unknown:xyz',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('GET /stream with unauthorized location channel returns 403', async () => {
    // User has access to locId but not to otherLocId
    const otherLocId = randomUUID();
    const userToken = await makeUserToken(userId, [locId]); // no access to otherLocId
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/notifications/stream?channels=location:${otherLocId}:alerts`,
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('GET /stream with another user channel returns 403', async () => {
    const otherUserId = randomUUID();
    const userToken = await makeUserToken(userId, [locId]);
    const res = await ctx.app.inject({
      method: 'GET',
      url: `/notifications/stream?channels=user:${otherUserId}:inbox`,
      headers: { Authorization: `Bearer ${userToken}` },
    });
    expect(res.statusCode).toBe(403);
  });

  // ─── /notifications/publish ───────────────────────────────────────────────

  it('POST /publish with no token returns 401', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/notifications/publish',
      body: { channel: validChannel, title: 'Test' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /publish with invalid token returns 403', async () => {
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/notifications/publish',
      headers: { Authorization: 'Bearer not-a-valid-jwt' },
      body: { channel: validChannel, title: 'Test' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /publish with wrong secret returns 403', async () => {
    const wrongKey = createSecretKey(Buffer.from('wrong-secret-entirely', 'utf-8'));
    const token = await new SignJWT({ sub: 'service' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuedAt()
      .setExpirationTime('1h')
      .sign(wrongKey);

    const res = await ctx.app.inject({
      method: 'POST',
      url: '/notifications/publish',
      headers: { Authorization: `Bearer ${token}` },
      body: { channel: validChannel, title: 'Test' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('POST /publish with invalid channel pattern returns 400', async () => {
    const serviceToken = await makeServiceToken();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/notifications/publish',
      headers: { Authorization: `Bearer ${serviceToken}` },
      body: { channel: 'bad-channel', title: 'Test' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ error: string }>().error).toBe('invalid_channel_pattern');
  });

  it('POST /publish with valid service JWT succeeds', async () => {
    const serviceToken = await makeServiceToken();
    const res = await ctx.app.inject({
      method: 'POST',
      url: '/notifications/publish',
      headers: { Authorization: `Bearer ${serviceToken}` },
      body: { channel: validChannel, title: 'Valid publish' },
    });
    expect(res.statusCode).toBe(201);
  });
});
