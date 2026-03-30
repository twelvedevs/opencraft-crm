import { describe, it, beforeAll, beforeEach, afterAll, expect } from 'vitest';
import {
  createTestContext,
  resetSchema,
  truncateTables,
  makeStaffToken,
  makeManagerToken,
  makeServiceApiKey,
  type TestContext,
} from './helpers.js';
import { templateCache } from '../../src/services/template-cache.js';

let ctx: TestContext;

// Use UUID subs to satisfy the uuid column constraint on created_by
const STAFF_UUID = '00000000-0000-0000-0000-000000000001';
const MANAGER_UUID = '00000000-0000-0000-0000-000000000002';

beforeAll(async () => {
  ctx = await createTestContext();
  await resetSchema(ctx.db);
});

beforeEach(async () => {
  await truncateTables(ctx.db);
});

afterAll(async () => {
  await ctx.close();
});

async function svcAuth(): Promise<string> {
  return `Bearer ${makeServiceApiKey()}`;
}

async function staffAuth(): Promise<string> {
  return `Bearer ${await makeStaffToken(STAFF_UUID)}`;
}

async function managerAuth(): Promise<string> {
  return `Bearer ${await makeManagerToken(MANAGER_UUID)}`;
}

async function createAndActivateSmsTemplate(name: string, bodyText: string): Promise<string> {
  const mgrAuth = await managerAuth();
  // Create
  const createRes = await fetch(`${ctx.serverUrl}/templates`, {
    method: 'POST',
    headers: { Authorization: mgrAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, channel: 'sms' }),
  });
  const { id } = await createRes.json() as { id: string };

  // Patch body_text
  await fetch(`${ctx.serverUrl}/templates/${id}`, {
    method: 'PATCH',
    headers: { Authorization: mgrAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ body_text: bodyText }),
  });

  // Activate
  await fetch(`${ctx.serverUrl}/templates/${id}/activate`, {
    method: 'POST',
    headers: { Authorization: mgrAuth },
  });

  return id;
}

async function createAndActivateEmailTemplate(
  name: string,
  opts: { subject: string; body_html: string; body_text: string },
): Promise<string> {
  const mgrAuth = await managerAuth();

  const createRes = await fetch(`${ctx.serverUrl}/templates`, {
    method: 'POST',
    headers: { Authorization: mgrAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, channel: 'email' }),
  });
  const { id } = await createRes.json() as { id: string };

  await fetch(`${ctx.serverUrl}/templates/${id}`, {
    method: 'PATCH',
    headers: { Authorization: mgrAuth, 'Content-Type': 'application/json' },
    body: JSON.stringify(opts),
  });

  await fetch(`${ctx.serverUrl}/templates/${id}/activate`, {
    method: 'POST',
    headers: { Authorization: mgrAuth },
  });

  return id;
}

async function render(
  templateId: string,
  context: Record<string, unknown>,
  authHeader?: string,
): Promise<Response> {
  return fetch(`${ctx.serverUrl}/templates/render`, {
    method: 'POST',
    headers: {
      Authorization: authHeader ?? (await svcAuth()),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ template_id: templateId, context }),
  });
}

describe('POST /templates/render', () => {
  it('renders active SMS template with merge tags', async () => {
    const id = await createAndActivateSmsTemplate('SMS Render Test', 'Hi {{first_name}}!');
    const res = await render(id, { first_name: 'Sarah' });
    expect(res.status).toBe(200);
    const body = await res.json() as { channel: string; body_text: string };
    expect(body.channel).toBe('sms');
    expect(body.body_text).toBe('Hi Sarah!');
  });

  it('renders active email template with merge tags', async () => {
    const id = await createAndActivateEmailTemplate('Email Render Test', {
      subject: 'Hello {{first_name}}',
      body_html: '<p>Hello {{first_name}}</p>',
      body_text: 'Hello {{first_name}}',
    });
    const res = await render(id, { first_name: 'Sarah' });
    expect(res.status).toBe(200);
    const body = await res.json() as { channel: string; subject: string; body_html: string; body_text: string };
    expect(body.channel).toBe('email');
    expect(body.subject).toBe('Hello Sarah');
    expect(body.body_html).toBe('<p>Hello Sarah</p>');
    expect(body.body_text).toBe('Hello Sarah');
  });

  it('SMS render response contains only channel and body_text (no subject or body_html)', async () => {
    const id = await createAndActivateSmsTemplate('SMS Fields Test', 'Hello!');
    const res = await render(id, {});
    const body = await res.json() as Record<string, unknown>;
    expect(body.channel).toBe('sms');
    expect(body.body_text).toBeDefined();
    expect(body.subject).toBeUndefined();
    expect(body.body_html).toBeUndefined();
  });

  it('returns 404 for template with null active_version (draft, never activated)', async () => {
    const mgrAuth = await managerAuth();
    const createRes = await fetch(`${ctx.serverUrl}/templates`, {
      method: 'POST',
      headers: { Authorization: mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Draft Only', channel: 'sms' }),
    });
    const { id } = await createRes.json() as { id: string };
    const res = await render(id, {});
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Template not found or not renderable');
  });

  it('returns 404 for disabled template (eager cache eviction)', async () => {
    const id = await createAndActivateSmsTemplate('Disabled Render Test', 'Hi!');
    // Warm the cache
    await render(id, {});
    // Disable (evicts cache eagerly)
    const mgrAuth = await managerAuth();
    await fetch(`${ctx.serverUrl}/templates/${id}/disable`, {
      method: 'POST',
      headers: { Authorization: mgrAuth },
    });
    const res = await render(id, {});
    expect(res.status).toBe(404);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Template not found or not renderable');
  });

  it('draft edit does not affect render — still returns v1 content', async () => {
    const id = await createAndActivateSmsTemplate('Draft Edit Test', 'Original content');
    // Render v1
    const res1 = await render(id, {});
    expect(res1.status).toBe(200);
    const body1 = await res1.json() as { body_text: string };
    expect(body1.body_text).toBe('Original content');

    // Create draft v2 (do not activate)
    const mgrAuth = await managerAuth();
    await fetch(`${ctx.serverUrl}/templates/${id}`, {
      method: 'PATCH',
      headers: { Authorization: mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body_text: 'Draft v2 content' }),
    });

    // Render again — still returns v1
    templateCache.evict(id); // clear cache to force DB lookup
    const res2 = await render(id, {});
    expect(res2.status).toBe(200);
    const body2 = await res2.json() as { body_text: string };
    expect(body2.body_text).toBe('Original content');
  });

  it('activate evicts cache and subsequent render returns new content', async () => {
    const id = await createAndActivateSmsTemplate('Cache Evict Test', 'V1 content');
    // Render to cache v1
    await render(id, {});

    const mgrAuth = await managerAuth();
    // Create and activate v2
    await fetch(`${ctx.serverUrl}/templates/${id}`, {
      method: 'PATCH',
      headers: { Authorization: mgrAuth, 'Content-Type': 'application/json' },
      body: JSON.stringify({ body_text: 'V2 content' }),
    });
    await fetch(`${ctx.serverUrl}/templates/${id}/activate`, {
      method: 'POST',
      headers: { Authorization: mgrAuth },
    });

    // Render again — should return v2 (cache was evicted on activate)
    const res = await render(id, {});
    expect(res.status).toBe(200);
    const body = await res.json() as { body_text: string };
    expect(body.body_text).toBe('V2 content');
  });

  it('disable evicts cache — render immediately returns 404', async () => {
    const id = await createAndActivateSmsTemplate('Disable Evict Test', 'Hello!');
    // Warm cache
    await render(id, {});
    // Disable (cache evicted)
    const mgrAuth = await managerAuth();
    await fetch(`${ctx.serverUrl}/templates/${id}/disable`, {
      method: 'POST',
      headers: { Authorization: mgrAuth },
    });
    const res = await render(id, {});
    expect(res.status).toBe(404);
  });

  it('enable allows render after disable', async () => {
    const id = await createAndActivateSmsTemplate('Enable After Disable', 'Hello!');
    const mgrAuth = await managerAuth();
    await fetch(`${ctx.serverUrl}/templates/${id}/disable`, {
      method: 'POST',
      headers: { Authorization: mgrAuth },
    });
    await fetch(`${ctx.serverUrl}/templates/${id}/enable`, {
      method: 'POST',
      headers: { Authorization: mgrAuth },
    });
    const res = await render(id, {});
    expect(res.status).toBe(200);
    const body = await res.json() as { body_text: string };
    expect(body.body_text).toBe('Hello!');
  });

  it('missing context keys render as empty strings', async () => {
    const id = await createAndActivateSmsTemplate('Missing Keys Test', 'Hi {{first_name}}!');
    const res = await render(id, {});
    expect(res.status).toBe(200);
    const body = await res.json() as { body_text: string };
    expect(body.body_text).toBe('Hi !');
  });

  it('malformed merge tag in stored content → 400', async () => {
    const id = await createAndActivateSmsTemplate('Malformed Tag Test', 'Hi {{ }}');
    const res = await render(id, {});
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Malformed merge tag in template content');
  });

  it('unauthenticated request → 401', async () => {
    const id = await createAndActivateSmsTemplate('Unauth Test', 'Hello!');
    const res = await fetch(`${ctx.serverUrl}/templates/render`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ template_id: id, context: {} }),
    });
    expect(res.status).toBe(401);
  });

  it('service API key auth works for render', async () => {
    const id = await createAndActivateSmsTemplate('Service Key Test', 'Hello!');
    const res = await render(id, {}, `Bearer ${makeServiceApiKey()}`);
    expect(res.status).toBe(200);
  });

  it('staff JWT auth works for render', async () => {
    const id = await createAndActivateSmsTemplate('Staff Auth Test', 'Hello!');
    const res = await render(id, {}, await staffAuth());
    expect(res.status).toBe(200);
  });
});
