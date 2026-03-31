import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSendEmail } from '../../src/services/action-handlers/send-email.js';

const TEMPLATE_URL = 'http://template-service';
const EMAIL_URL = 'http://email-service';

const RENDER_RESPONSE = {
  subject: 'Test Subject',
  body_html: '<p>Test</p>',
  body_text: 'Test',
  body: 'Test SMS body',
};

function makeFetchMock() {
  return vi.fn(async (url: string) => {
    if (String(url).includes('/templates/render')) {
      return {
        ok: true,
        json: async () => RENDER_RESPONSE,
      } as Response;
    }
    return { ok: true, json: async () => ({}) } as Response;
  });
}

describe('send_email handler contract', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls POST /templates/render then POST /emails/send with rendered fields', async () => {
    const params = {
      template_id: 'tmpl-email-1',
      to: 'patient@example.com',
      from: 'clinic@example.com',
      dedup_key: 'enroll-1-step-2',
      context: {
        context: { email: 'patient@example.com' },
        enrollment_id: 'enroll-1',
      },
    };

    await executeSendEmail(params, TEMPLATE_URL, EMAIL_URL);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [renderUrl, renderInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(renderUrl).toBe(`${TEMPLATE_URL}/templates/render`);
    expect(renderInit.method).toBe('POST');
    const renderBody = JSON.parse(renderInit.body as string);
    expect(renderBody).toEqual({ template_id: 'tmpl-email-1', context: params.context });

    const [sendUrl, sendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(sendUrl).toBe(`${EMAIL_URL}/emails/send`);
    expect(sendInit.method).toBe('POST');
    const sendBody = JSON.parse(sendInit.body as string);
    expect(sendBody).toMatchObject({
      to: 'patient@example.com',
      from: 'clinic@example.com',
      subject: 'Test Subject',
      body_html: '<p>Test</p>',
      body_text: 'Test',
    });
  });

  it('passes pre-rendered subject + body_html + body_text (not template_id) to POST /emails/send', async () => {
    const params = {
      template_id: 'tmpl-email-1',
      to: 'patient@example.com',
      from: 'clinic@example.com',
      dedup_key: 'enroll-1-step-2',
      context: {},
    };

    await executeSendEmail(params, TEMPLATE_URL, EMAIL_URL);

    const [, sendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const sendBody = JSON.parse(sendInit.body as string);
    expect(sendBody).not.toHaveProperty('template_id');
    expect(sendBody).toHaveProperty('subject', 'Test Subject');
    expect(sendBody).toHaveProperty('body_html', '<p>Test</p>');
    expect(sendBody).toHaveProperty('body_text', 'Test');
  });
});
