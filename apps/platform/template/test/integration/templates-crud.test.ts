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

let ctx: TestContext;

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

// Use UUIDs for sub so created_by column (uuid type) accepts the value
const STAFF_UUID = '00000000-0000-0000-0000-000000000001';
const MANAGER_UUID = '00000000-0000-0000-0000-000000000002';

async function svcHeaders(): Promise<Record<string, string>> {
  // marketing_staff role satisfies the requireRole('marketing_staff') preHandler
  return { Authorization: `Bearer ${await makeStaffToken(STAFF_UUID)}`, 'Content-Type': 'application/json' };
}

async function managerHeaders(): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await makeManagerToken(MANAGER_UUID)}` };
}

async function staffHeaders(): Promise<Record<string, string>> {
  return { Authorization: `Bearer ${await makeStaffToken(STAFF_UUID)}` };
}

async function createTemplate(
  name: string,
  channel: 'sms' | 'email' = 'sms',
): Promise<{ id: string; status: string; current_version: number; active_version: number | null; channel: string }> {
  const res = await fetch(`${ctx.serverUrl}/templates`, {
    method: 'POST',
    headers: await svcHeaders(),
    body: JSON.stringify({ name, channel }),
  });
  return res.json() as Promise<{ id: string; status: string; current_version: number; active_version: number | null; channel: string }>;
}

async function activateTemplate(id: string): Promise<void> {
  await fetch(`${ctx.serverUrl}/templates/${id}/activate`, {
    method: 'POST',
    headers: await managerHeaders(),
  });
}

describe('POST /templates', () => {
  it('creates a draft template and returns 201', async () => {
    const res = await fetch(`${ctx.serverUrl}/templates`, {
      method: 'POST',
      headers: await svcHeaders(),
      body: JSON.stringify({ name: 'Welcome SMS', channel: 'sms' }),
    });
    expect(res.status).toBe(201);
    const body = await res.json() as Record<string, unknown>;
    expect(body.status).toBe('draft');
    expect(body.current_version).toBe(1);
    expect(body.active_version).toBeNull();
    expect(body.channel).toBe('sms');
  });

  it('returns 409 for duplicate name', async () => {
    await createTemplate('DuplicateTest');
    const res = await fetch(`${ctx.serverUrl}/templates`, {
      method: 'POST',
      headers: await svcHeaders(),
      body: JSON.stringify({ name: 'DuplicateTest', channel: 'sms' }),
    });
    expect(res.status).toBe(409);
    const body = await res.json() as Record<string, unknown>;
    expect(body.error).toBe('Template name already exists');
  });
});

describe('GET /templates', () => {
  it('returns paginated list with correct total', async () => {
    await createTemplate('Template A');
    await createTemplate('Template B');
    await createTemplate('Template C');
    const res = await fetch(`${ctx.serverUrl}/templates`, { headers: await svcHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as { data: unknown[]; total: number; limit: number; offset: number };
    expect(body.total).toBe(3);
    expect(body.data.length).toBe(3);
    expect(body.limit).toBe(20);
    expect(body.offset).toBe(0);
  });

  it('filters by channel=sms', async () => {
    await createTemplate('SMS One', 'sms');
    await createTemplate('Email One', 'email');
    const res = await fetch(`${ctx.serverUrl}/templates?channel=sms`, { headers: await svcHeaders() });
    const body = await res.json() as { data: Array<{ channel: string }>; total: number };
    expect(body.total).toBe(1);
    expect(body.data[0].channel).toBe('sms');
  });

  it('filters by status=active', async () => {
    const t1 = await createTemplate('Active Template');
    await createTemplate('Draft Template');
    await activateTemplate(t1.id);
    const res = await fetch(`${ctx.serverUrl}/templates?status=active`, { headers: await svcHeaders() });
    const body = await res.json() as { data: unknown[]; total: number };
    expect(body.total).toBe(1);
    expect(body.data.length).toBe(1);
  });

  it('returns templates in ascending created_at order', async () => {
    const t1 = await createTemplate('First Template');
    const t2 = await createTemplate('Second Template');
    const res = await fetch(`${ctx.serverUrl}/templates?sort=created_at&order=asc`, { headers: await svcHeaders() });
    const body = await res.json() as { data: Array<{ id: string }> };
    expect(body.data.length).toBeGreaterThanOrEqual(2);
    const ids = body.data.map((t) => t.id);
    expect(ids.indexOf(t1.id)).toBeLessThan(ids.indexOf(t2.id));
  });
});

describe('GET /templates/:id', () => {
  it('returns group row with draft_content and active_content null when never activated', async () => {
    const { id } = await createTemplate('Detail Test');
    const res = await fetch(`${ctx.serverUrl}/templates/${id}`, { headers: await svcHeaders() });
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body.draft_content).not.toBeNull();
    expect(body.active_content).toBeNull();
  });

  it('returns active_content populated after activation', async () => {
    const { id } = await createTemplate('Active Detail Test');
    await activateTemplate(id);
    const res = await fetch(`${ctx.serverUrl}/templates/${id}`, { headers: await svcHeaders() });
    const body = await res.json() as Record<string, unknown>;
    expect(body.active_content).not.toBeNull();
  });
});

describe('PATCH /templates/:id', () => {
  it('updates draft version in-place on never-activated template (current_version stays 1)', async () => {
    const { id } = await createTemplate('Patch Draft');
    const res = await fetch(`${ctx.serverUrl}/templates/${id}`, {
      method: 'PATCH',
      headers: await svcHeaders(),
      body: JSON.stringify({ body_text: 'Hello {{name}}' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { current_version: number; draft_content: { body_text: string } };
    expect(body.current_version).toBe(1);
    expect(body.draft_content.body_text).toBe('Hello {{name}}');
  });

  it('creates new draft version after activation (current_version becomes 2)', async () => {
    const { id } = await createTemplate('Patch Active');
    await activateTemplate(id);
    const res = await fetch(`${ctx.serverUrl}/templates/${id}`, {
      method: 'PATCH',
      headers: await svcHeaders(),
      body: JSON.stringify({ body_text: 'New content' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as {
      current_version: number;
      active_version: number;
      draft_content: { body_text: string };
    };
    expect(body.current_version).toBe(2);
    expect(body.active_version).toBe(1);
    expect(body.draft_content.body_text).toBe('New content');
  });

  it('updates existing draft in-place when draft > active (current_version stays at 2)', async () => {
    const { id } = await createTemplate('Patch In Progress');
    await activateTemplate(id);
    // First patch: creates draft v2
    await fetch(`${ctx.serverUrl}/templates/${id}`, {
      method: 'PATCH',
      headers: await svcHeaders(),
      body: JSON.stringify({ body_text: 'Draft v2 content' }),
    });
    // Second patch: should update v2 in-place
    const res = await fetch(`${ctx.serverUrl}/templates/${id}`, {
      method: 'PATCH',
      headers: await svcHeaders(),
      body: JSON.stringify({ body_text: 'Draft v2 updated' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { current_version: number; draft_content: { body_text: string } };
    expect(body.current_version).toBe(2);
    expect(body.draft_content.body_text).toBe('Draft v2 updated');
  });

  it('silently ignores email-only fields on SMS template', async () => {
    const { id } = await createTemplate('SMS Channel');
    const patchRes = await fetch(`${ctx.serverUrl}/templates/${id}`, {
      method: 'PATCH',
      headers: await svcHeaders(),
      body: JSON.stringify({ subject: 'Test', body_html: '<p>Hi</p>' }),
    });
    expect(patchRes.status).toBe(200);
    const getRes = await fetch(`${ctx.serverUrl}/templates/${id}`, { headers: await svcHeaders() });
    const body = await getRes.json() as { draft_content: { subject: string | null; body_html: string | null } };
    expect(body.draft_content.subject).toBeNull();
    expect(body.draft_content.body_html).toBeNull();
  });

  it('returns 400 when body_text exceeds 1600 chars on SMS template', async () => {
    const { id } = await createTemplate('SMS Limit Test');
    const res = await fetch(`${ctx.serverUrl}/templates/${id}`, {
      method: 'PATCH',
      headers: await svcHeaders(),
      body: JSON.stringify({ body_text: 'a'.repeat(1601) }),
    });
    expect(res.status).toBe(400);
  });

  it('allows patch on disabled template and status stays disabled', async () => {
    const { id } = await createTemplate('Disabled Patch');
    await fetch(`${ctx.serverUrl}/templates/${id}/disable`, {
      method: 'POST',
      headers: await managerHeaders(),
    });
    const res = await fetch(`${ctx.serverUrl}/templates/${id}`, {
      method: 'PATCH',
      headers: await svcHeaders(),
      body: JSON.stringify({ body_text: 'Patched while disabled' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('disabled');
  });
});

describe('POST /templates/:id/activate', () => {
  it('activates template with manager token → 200 with active_version === current_version, status === active', async () => {
    const { id } = await createTemplate('To Activate');
    const res = await fetch(`${ctx.serverUrl}/templates/${id}/activate`, {
      method: 'POST',
      headers: await managerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { active_version: number; current_version: number; status: string };
    expect(body.status).toBe('active');
    expect(body.active_version).toBe(body.current_version);
  });

  it('returns 403 with staff token', async () => {
    const { id } = await createTemplate('Staff Activate Blocked');
    const res = await fetch(`${ctx.serverUrl}/templates/${id}/activate`, {
      method: 'POST',
      headers: await staffHeaders(),
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /templates/:id/disable', () => {
  it('disables active template with manager token → 200 with status disabled', async () => {
    const { id } = await createTemplate('To Disable Active');
    await activateTemplate(id);
    const res = await fetch(`${ctx.serverUrl}/templates/${id}/disable`, {
      method: 'POST',
      headers: await managerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('disabled');
  });

  it('disables draft (never activated) with manager token → 200 with warning field', async () => {
    const { id } = await createTemplate('Draft Disable');
    const res = await fetch(`${ctx.serverUrl}/templates/${id}/disable`, {
      method: 'POST',
      headers: await managerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { warning?: string };
    expect(body.warning).toBeDefined();
  });

  it('returns 400 when already disabled', async () => {
    const { id } = await createTemplate('Double Disable');
    await fetch(`${ctx.serverUrl}/templates/${id}/disable`, {
      method: 'POST',
      headers: await managerHeaders(),
    });
    const res = await fetch(`${ctx.serverUrl}/templates/${id}/disable`, {
      method: 'POST',
      headers: await managerHeaders(),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Template is already disabled');
  });

  it('returns 403 with staff token', async () => {
    const { id } = await createTemplate('Staff Disable Blocked');
    const res = await fetch(`${ctx.serverUrl}/templates/${id}/disable`, {
      method: 'POST',
      headers: await staffHeaders(),
    });
    expect(res.status).toBe(403);
  });
});

describe('POST /templates/:id/enable', () => {
  it('enables disabled template (with active_version) with manager token → 200 with status active', async () => {
    const { id } = await createTemplate('To Enable');
    await activateTemplate(id);
    await fetch(`${ctx.serverUrl}/templates/${id}/disable`, {
      method: 'POST',
      headers: await managerHeaders(),
    });
    const res = await fetch(`${ctx.serverUrl}/templates/${id}/enable`, {
      method: 'POST',
      headers: await managerHeaders(),
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { status: string };
    expect(body.status).toBe('active');
  });

  it('returns 400 when template is not disabled (active)', async () => {
    const { id } = await createTemplate('Active Enable Error');
    await activateTemplate(id);
    const res = await fetch(`${ctx.serverUrl}/templates/${id}/enable`, {
      method: 'POST',
      headers: await managerHeaders(),
    });
    expect(res.status).toBe(400);
    const body = await res.json() as { error: string };
    expect(body.error).toBe('Template is not disabled');
  });

  it('returns 403 with staff token', async () => {
    const { id } = await createTemplate('Staff Enable Blocked');
    await activateTemplate(id);
    await fetch(`${ctx.serverUrl}/templates/${id}/disable`, {
      method: 'POST',
      headers: await managerHeaders(),
    });
    const res = await fetch(`${ctx.serverUrl}/templates/${id}/enable`, {
      method: 'POST',
      headers: await staffHeaders(),
    });
    expect(res.status).toBe(403);
  });
});
