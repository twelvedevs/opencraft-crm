import { describe, it, expect } from 'vitest';
import { createHmac } from 'node:crypto';
import {
  validateTwilioSignature,
  classifyInboundMessage,
  STOP_KEYWORDS,
  UNSTOP_KEYWORDS,
} from '../../src/services/twilio-webhook.js';

function generateSignature(
  authToken: string,
  url: string,
  params: Record<string, string>,
): string {
  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }
  return createHmac('sha1', authToken).update(data).digest('base64');
}

describe('validateTwilioSignature', () => {
  const authToken = 'test-auth-token-12345';
  const url = 'https://example.com/webhooks/twilio/inbound';
  const params = { From: '+15551234567', To: '+15559876543', Body: 'Hello' };

  it('accepts a valid HMAC-SHA1 signature', () => {
    const sig = generateSignature(authToken, url, params);
    expect(validateTwilioSignature(authToken, sig, url, params)).toBe(true);
  });

  it('rejects a tampered payload', () => {
    const sig = generateSignature(authToken, url, params);
    const tampered = { ...params, Body: 'Tampered' };
    expect(validateTwilioSignature(authToken, sig, url, tampered)).toBe(false);
  });

  it('rejects a missing signature', () => {
    expect(validateTwilioSignature(authToken, '', url, params)).toBe(false);
  });

  it('rejects an incorrect signature', () => {
    expect(
      validateTwilioSignature(authToken, 'badsignature==', url, params),
    ).toBe(false);
  });

  it('handles empty params', () => {
    const sig = generateSignature(authToken, url, {});
    expect(validateTwilioSignature(authToken, sig, url, {})).toBe(true);
  });
});

describe('classifyInboundMessage', () => {
  it('detects all STOP keyword variants', () => {
    for (const keyword of STOP_KEYWORDS) {
      expect(classifyInboundMessage(keyword)).toBe('stop');
    }
  });

  it('detects UNSTOP and START keywords', () => {
    for (const keyword of UNSTOP_KEYWORDS) {
      expect(classifyInboundMessage(keyword)).toBe('unstop');
    }
  });

  it('is case-insensitive', () => {
    expect(classifyInboundMessage('stop')).toBe('stop');
    expect(classifyInboundMessage('Stop')).toBe('stop');
    expect(classifyInboundMessage('sToP')).toBe('stop');
    expect(classifyInboundMessage('start')).toBe('unstop');
    expect(classifyInboundMessage('Start')).toBe('unstop');
  });

  it('trims whitespace', () => {
    expect(classifyInboundMessage('  STOP  ')).toBe('stop');
    expect(classifyInboundMessage('\tSTART\n')).toBe('unstop');
    expect(classifyInboundMessage(' QUIT ')).toBe('stop');
  });

  it('classifies normal messages', () => {
    expect(classifyInboundMessage('Hello there')).toBe('normal');
    expect(classifyInboundMessage('Please stop sending')).toBe('normal');
    expect(classifyInboundMessage('STOPPED')).toBe('normal');
    expect(classifyInboundMessage('STARTING')).toBe('normal');
    expect(classifyInboundMessage('')).toBe('normal');
  });
});
