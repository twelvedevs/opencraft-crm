import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import {
  HAS_DB,
  buildTestApp,
  runMigrations,
  cleanup,
  truncateTables,
  makeJwt,
  LOCATION_ID,
} from './helpers.js';

describe.skipIf(!HAS_DB)('score-commentary route (integration)', () => {
  let app: FastifyInstance;
  let agentToken: string;

  // Store reference to the mockFetch installed by helpers so we can intercept AI calls
  let originalFetch: typeof globalThis.fetch;

  beforeAll(async () => {
    await runMigrations();
    app = await buildTestApp();
    await app.ready();
    agentToken = makeJwt({ role: 'call_center_agent', locations: [LOCATION_ID] });
    // Capture the current fetch (which is the JWKS mock from helpers)
    originalFetch = globalThis.fetch;
  });

  afterAll(async () => {
    await app.close();
    await cleanup();
  });

  beforeEach(async () => {
    await truncateTables();
    // Restore the helpers mock fetch before each test
    globalThis.fetch = originalFetch;
  });

  const validLead = {
    first_name: 'John',
    last_name: 'Doe',
    phone: '2125551234',
    channel: 'website_form',
    location_id: LOCATION_ID,
  };

  async function createLead(): Promise<string> {
    const res = await app.inject({
      method: 'POST',
      url: '/leads',
      headers: { authorization: `Bearer ${agentToken}` },
      payload: validLead,
    });
    return res.json().id;
  }

  it('returns 200 with score and commentary on AI success', async () => {
    const leadId = await createLead();

    // Wrap the existing mock fetch to also intercept AI calls
    const jwksFetch = originalFetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/ai/complete')) {
        return Promise.resolve(new Response(
          JSON.stringify({ commentary: 'This lead has a low score indicating early stage engagement.' }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ));
      }
      return jwksFetch(input, init);
    }) as typeof globalThis.fetch;

    const res = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/score-commentary`,
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.score).toBe(0);
    expect(body.commentary).toBe('This lead has a low score indicating early stage engagement.');
  });

  it('returns 503 when AI service returns non-2xx', async () => {
    const leadId = await createLead();

    const jwksFetch = originalFetch;
    globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/ai/complete')) {
        return Promise.resolve(new Response('Internal Server Error', { status: 500 }));
      }
      return jwksFetch(input, init);
    }) as typeof globalThis.fetch;

    const res = await app.inject({
      method: 'GET',
      url: `/leads/${leadId}/score-commentary`,
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('AI service unavailable');
  });

  it('returns 404 for unknown lead', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/leads/00000000-0000-0000-0000-000000000099/score-commentary',
      headers: { authorization: `Bearer ${agentToken}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
