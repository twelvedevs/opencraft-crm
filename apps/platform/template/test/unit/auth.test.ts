import { describe, it, expect, vi } from 'vitest';
import { SignJWT } from 'jose';
import { verifyJwt, isServiceApiKey, requireAuth, requireRole } from '../../src/plugins/auth.js';

const SECRET = 'test-secret-key-for-signing';

async function signToken(claims: object): Promise<string> {
  const key = new TextEncoder().encode(SECRET);
  return new SignJWT(claims as Record<string, unknown>)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .sign(key);
}

function makeReply() {
  const reply = {
    _status: 200 as number,
    _body: undefined as unknown,
    status(code: number) {
      this._status = code;
      return this;
    },
    send(body: unknown) {
      this._body = body;
      return this;
    },
  };
  return reply;
}

function makeRequest(authHeader?: string) {
  return {
    headers: {
      authorization: authHeader,
    },
  } as unknown as Parameters<typeof requireAuth>[0] extends (req: infer R) => unknown ? R : never;
}

describe('verifyJwt', () => {
  it('returns claims for a valid JWT with roles', async () => {
    const token = await signToken({ sub: 'user-1', roles: ['marketing_staff'] });
    const claims = await verifyJwt(`Bearer ${token}`, SECRET);
    expect(claims.sub).toBe('user-1');
    expect(claims.roles).toContain('marketing_staff');
  });

  it('throws 401 when Authorization header is missing', async () => {
    await expect(verifyJwt(undefined, SECRET)).rejects.toMatchObject({ statusCode: 401 });
  });

  it('throws 401 when JWT has wrong signature', async () => {
    const token = await signToken({ sub: 'user-1' });
    await expect(verifyJwt(`Bearer ${token}`, 'wrong-secret')).rejects.toMatchObject({
      statusCode: 401,
      message: 'Invalid token',
    });
  });
});

describe('isServiceApiKey', () => {
  it('returns true for Bearer ak_ token', () => {
    expect(isServiceApiKey('Bearer ak_test123')).toBe(true);
  });

  it('returns false for undefined', () => {
    expect(isServiceApiKey(undefined)).toBe(false);
  });

  it('returns false for regular JWT bearer', async () => {
    const token = await signToken({ sub: 'user-1' });
    expect(isServiceApiKey(`Bearer ${token}`)).toBe(false);
  });
});

describe('requireAuth', () => {
  it('passes for valid user JWT', async () => {
    const token = await signToken({ sub: 'user-1', roles: ['marketing_staff'] });
    const handler = requireAuth(SECRET);
    const req = makeRequest(`Bearer ${token}`);
    const reply = makeReply();
    await handler(req as never, reply as never);
    expect(reply._status).toBe(200); // unchanged means no early reply
  });

  it('passes for service API key', async () => {
    const handler = requireAuth(SECRET);
    const req = makeRequest('Bearer ak_test123');
    const reply = makeReply();
    await handler(req as never, reply as never);
    expect(reply._status).toBe(200); // unchanged
  });

  it('returns 401 for random non-JWT non-ak_ bearer token', async () => {
    const handler = requireAuth(SECRET);
    const req = makeRequest('Bearer notavalidtoken');
    const reply = makeReply();
    await handler(req as never, reply as never);
    expect(reply._status).toBe(401);
  });

  it('returns 401 for missing Authorization header', async () => {
    const handler = requireAuth(SECRET);
    const req = makeRequest(undefined);
    const reply = makeReply();
    await handler(req as never, reply as never);
    expect(reply._status).toBe(401);
  });
});

describe('requireRole', () => {
  it('passes for JWT with the required role', async () => {
    const token = await signToken({ sub: 'user-1', roles: ['marketing_staff'] });
    const handler = requireRole('marketing_staff', SECRET);
    const req = makeRequest(`Bearer ${token}`);
    const reply = makeReply();
    await handler(req as never, reply as never);
    expect(reply._status).toBe(200); // unchanged
  });

  it('returns 403 for JWT missing the required role', async () => {
    const token = await signToken({ sub: 'user-1', roles: ['marketing_staff'] });
    const handler = requireRole('marketing_manager', SECRET);
    const req = makeRequest(`Bearer ${token}`);
    const reply = makeReply();
    await handler(req as never, reply as never);
    expect(reply._status).toBe(403);
  });

  it('returns 401 for missing Authorization header', async () => {
    const handler = requireRole('marketing_manager', SECRET);
    const req = makeRequest(undefined);
    const reply = makeReply();
    await handler(req as never, reply as never);
    expect(reply._status).toBe(401);
  });

  it('returns 401 for JWT with wrong signature', async () => {
    const token = await signToken({ sub: 'user-1', roles: ['marketing_manager'] });
    const handler = requireRole('marketing_manager', 'wrong-secret');
    const req = makeRequest(`Bearer ${token}`);
    const reply = makeReply();
    await handler(req as never, reply as never);
    expect(reply._status).toBe(401);
  });
});
