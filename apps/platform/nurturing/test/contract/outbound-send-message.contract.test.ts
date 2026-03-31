import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeSendMessage } from '../../src/services/action-handlers/send-message.js';

const TEMPLATE_URL = 'http://template-service';
const MESSAGING_URL = 'http://messaging-service';

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

describe('send_message handler contract', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = makeFetchMock();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls POST /templates/render with template_id and context before POST /messages/send', async () => {
    const params = {
      template_id: 'tmpl-sms-1',
      to: '+15550001111',
      from: '+15559998888',
      dedup_key: 'enroll-1-step-1',
      context: {
        context: { phone: '+15550001111' },
        enrollment_id: 'enroll-1',
        location_timezone: 'America/New_York',
      },
    };

    await executeSendMessage(params, TEMPLATE_URL, MESSAGING_URL);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [renderUrl, renderInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(renderUrl).toBe(`${TEMPLATE_URL}/templates/render`);
    expect(renderInit.method).toBe('POST');
    const renderBody = JSON.parse(renderInit.body as string);
    expect(renderBody).toEqual({ template_id: 'tmpl-sms-1', context: params.context });

    const [sendUrl, sendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    expect(sendUrl).toBe(`${MESSAGING_URL}/messages/send`);
    expect(sendInit.method).toBe('POST');
    const sendBody = JSON.parse(sendInit.body as string);
    expect(sendBody).toMatchObject({
      to: '+15550001111',
      from: '+15559998888',
      body: 'Test SMS body',
      dedup_key: 'enroll-1-step-1',
    });
  });

  it('passes pre-rendered body (not template_id) to POST /messages/send', async () => {
    const params = {
      template_id: 'tmpl-sms-1',
      to: '+15550001111',
      from: '+15559998888',
      dedup_key: 'enroll-1-step-1',
      context: {},
    };

    await executeSendMessage(params, TEMPLATE_URL, MESSAGING_URL);

    const [, sendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const sendBody = JSON.parse(sendInit.body as string);
    expect(sendBody).not.toHaveProperty('template_id');
    expect(sendBody).toHaveProperty('body', 'Test SMS body');
  });

  it('dedup_key is present in POST /messages/send body', async () => {
    const params = {
      template_id: 'tmpl-sms-1',
      to: '+15550001111',
      from: '+15559998888',
      dedup_key: 'enroll-42-step-3',
      context: {},
    };

    await executeSendMessage(params, TEMPLATE_URL, MESSAGING_URL);

    const [, sendInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const sendBody = JSON.parse(sendInit.body as string);
    expect(sendBody.dedup_key).toBe('enroll-42-step-3');
    expect(sendBody.dedup_key.length).toBeGreaterThan(0);
  });
});
