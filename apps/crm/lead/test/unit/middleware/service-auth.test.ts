import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../../src/env.js', () => ({
  env: { SERVICE_AUTH_TOKEN: 'test-service-token-12345' },
}));

import { serviceAuthHook } from '../../../src/middleware/service-auth.js';

function makeRequest(authHeader?: string) {
  return {
    headers: {
      authorization: authHeader,
    },
  } as any;
}

function makeReply() {
  const reply: any = {
    code: vi.fn().mockReturnThis(),
    send: vi.fn().mockReturnThis(),
  };
  return reply;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('serviceAuthHook', () => {
  it('passes with valid SERVICE_AUTH_TOKEN', async () => {
    const request = makeRequest('Bearer test-service-token-12345');
    const reply = makeReply();

    await serviceAuthHook(request, reply);

    expect(reply.code).not.toHaveBeenCalled();
  });

  it('returns 401 when Authorization header is missing', async () => {
    const request = makeRequest(undefined);
    const reply = makeReply();

    await serviceAuthHook(request, reply);

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Unauthorized' });
  });

  it('returns 401 when header is not Bearer-prefixed', async () => {
    const request = makeRequest('Basic test-service-token-12345');
    const reply = makeReply();

    await serviceAuthHook(request, reply);

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Unauthorized' });
  });

  it('returns 401 with wrong token', async () => {
    const request = makeRequest('Bearer wrong-token');
    const reply = makeReply();

    await serviceAuthHook(request, reply);

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Unauthorized' });
  });

  it('returns 401 with token of different length', async () => {
    const request = makeRequest('Bearer short');
    const reply = makeReply();

    await serviceAuthHook(request, reply);

    expect(reply.code).toHaveBeenCalledWith(401);
    expect(reply.send).toHaveBeenCalledWith({ error: 'Unauthorized' });
  });
});
