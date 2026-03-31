import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { executeCallAi } from '../../src/services/action-handlers/call-ai.js';
import { executeAction } from '../../src/services/action-executor.js';
import { EventBridgeClient } from '@aws-sdk/client-eventbridge';

const AI_URL = 'http://ai-service';
const MESSAGING_URL = 'http://messaging-service';

const AI_RESPONSE_TEXT = 'Here is your follow-up message.';

function makeAiFetchMock() {
  return vi.fn(async () => ({
    ok: true,
    json: async () => ({ text: AI_RESPONSE_TEXT }),
  })) as unknown as typeof fetch;
}

describe('call_ai handler contract', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchMock = makeAiFetchMock();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls POST /ai/complete with { system_prompt, user_prompt, model } only', async () => {
    await executeCallAi(
      { system_prompt: 'You are a helpful assistant.', user_prompt: 'Follow up on this lead.', model: 'claude-haiku-4-5', auto_send: false },
      AI_URL,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`${AI_URL}/ai/complete`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body).toEqual({
      system_prompt: 'You are a helpful assistant.',
      user_prompt: 'Follow up on this lead.',
      model: 'claude-haiku-4-5',
    });
  });

  it('user_prompt and system_prompt are resolved via @ortho/interpolator before sending', async () => {
    // {{enrollment_id}} and {{entity_id}} are top-level keys in the interpolation context
    // (context.* dot-path values work when the entire string is a dot-path, e.g. "context.first_name")
    const stepDef = {
      id: 'step-1',
      action: {
        type: 'call_ai',
        params: {
          system_prompt: 'You are helping lead {{entity_id}}.',
          user_prompt: 'Follow up for enrollment {{enrollment_id}}.',
          model: 'claude-haiku-4-5',
          auto_send: false,
        },
      },
    };

    const execCtx = {
      enrollment_id: 'enroll-abc',
      step_id: 'step-1',
      entity_type: 'lead',
      entity_id: 'lead-xyz',
      enrollmentContext: {},
      abVariant: null,
    };

    const deps = {
      urls: {
        aiServiceUrl: AI_URL,
        messagingServiceUrl: MESSAGING_URL,
        templateServiceUrl: 'http://template-service',
        emailServiceUrl: 'http://email-service',
      },
      ebClient: new EventBridgeClient({}),
      busName: 'test-bus',
    };

    await executeAction(stepDef, execCtx, deps);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(init.body as string);
    expect(body.system_prompt).toBe('You are helping lead lead-xyz.');
    expect(body.user_prompt).toBe('Follow up for enrollment enroll-abc.');
  });

  it('with auto_send: false — stores AI output and does NOT call POST /messages/send', async () => {
    const result = await executeCallAi(
      { system_prompt: 'sys', user_prompt: 'user', model: 'claude-haiku-4-5', auto_send: false },
      AI_URL,
    );

    expect(result.output).toBe(AI_RESPONSE_TEXT);
    expect(result.auto_send).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/ai/complete');
    expect(url).not.toContain('/messages/send');
  });

  it('with auto_send: true — result includes chainSendMessage with AI output as body', async () => {
    const stepDef = {
      id: 'step-2',
      action: {
        type: 'call_ai',
        params: {
          system_prompt: 'You are a helpful assistant.',
          user_prompt: 'Follow up on this lead.',
          model: 'claude-haiku-4-5',
          auto_send: true,
          to_field: '+15550001111',
          from_field: '+15559998888',
          dedup_key: 'enroll-1-step-2',
        },
      },
    };

    const execCtx = {
      enrollment_id: 'enroll-1',
      step_id: 'step-2',
      entity_type: 'lead',
      entity_id: 'lead-1',
      enrollmentContext: {},
      abVariant: null,
    };

    const deps = {
      urls: {
        aiServiceUrl: AI_URL,
        messagingServiceUrl: MESSAGING_URL,
        templateServiceUrl: 'http://template-service',
        emailServiceUrl: 'http://email-service',
      },
      ebClient: new EventBridgeClient({}),
      busName: 'test-bus',
    };

    const result = await executeAction(stepDef, execCtx, deps);

    expect(result.chainSendMessage).toBeDefined();
    expect(result.chainSendMessage!.body).toBe(AI_RESPONSE_TEXT);
    expect(result.chainSendMessage!.to).toBe('+15550001111');
    expect(result.chainSendMessage!.from).toBe('+15559998888');
    expect(result.chainSendMessage!.dedup_key).toBe('enroll-1-step-2');
  });
});
