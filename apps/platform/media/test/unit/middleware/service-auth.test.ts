import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/env.js', () => ({
  env: {
    SERVICE_AUTH_TOKEN: 'test-secret-token',
  },
}));

import { serviceAuthHook } from '../../../src/middleware/service-auth.js';
import type { FastifyRequest, FastifyReply } from 'fastify';

function makeRequest(authHeader?: string): FastifyRequest {
  return {
    headers: {
      ...(authHeader !== undefined ? { authorization: authHeader } : {}),
    },
  } as unknown as FastifyRequest;
}

function makeReply(): FastifyReply {
  const reply: Record<string, unknown> = {};
  reply.code = vi.fn().mockReturnValue(reply);
  reply.send = vi.fn().mockReturnValue(reply);
  return reply as unknown as FastifyReply;
}

describe('service-auth middleware', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('passes through with valid token', async () => {
    const request = makeRequest('Bearer test-secret-token');
    const reply = makeReply();

    await serviceAuthHook(request, reply);

    expect((reply as any).code).not.toHaveBeenCalled();
    expect((reply as any).send).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const request = makeRequest(undefined);
    const reply = makeReply();

    await serviceAuthHook(request, reply);

    expect((reply as any).code).toHaveBeenCalledWith(401);
    expect((reply as any).send).toHaveBeenCalledWith({ error: 'Unauthorized' });
  });

  it('returns 401 when token is wrong', async () => {
    const request = makeRequest('Bearer wrong-token');
    const reply = makeReply();

    await serviceAuthHook(request, reply);

    expect((reply as any).code).toHaveBeenCalledWith(401);
    expect((reply as any).send).toHaveBeenCalledWith({ error: 'Unauthorized' });
  });

  it('returns 401 when Authorization header is not Bearer format', async () => {
    const request = makeRequest('Basic dXNlcjpwYXNz');
    const reply = makeReply();

    await serviceAuthHook(request, reply);

    expect((reply as any).code).toHaveBeenCalledWith(401);
    expect((reply as any).send).toHaveBeenCalledWith({ error: 'Unauthorized' });
  });
});
