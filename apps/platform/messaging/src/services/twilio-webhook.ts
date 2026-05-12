import { createHmac, timingSafeEqual } from 'node:crypto';

export function validateTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>,
): boolean {
  if (!signature) return false;

  const sortedKeys = Object.keys(params).sort();
  let data = url;
  for (const key of sortedKeys) {
    data += key + params[key];
  }

  const expected = createHmac('sha1', authToken).update(data).digest('base64');

  const sigBuf = Buffer.from(signature);
  const expectedBuf = Buffer.from(expected);

  if (sigBuf.length !== expectedBuf.length) return false;

  return timingSafeEqual(sigBuf, expectedBuf);
}

export const STOP_KEYWORDS: string[] = [
  'STOP',
  'STOPALL',
  'UNSUBSCRIBE',
  'CANCEL',
  'END',
  'QUIT',
];

export const UNSTOP_KEYWORDS: string[] = ['UNSTOP', 'START'];

export function classifyInboundMessage(
  body: string,
): 'stop' | 'unstop' | 'normal' {
  const normalized = body.trim().toUpperCase();
  if (STOP_KEYWORDS.includes(normalized)) return 'stop';
  if (UNSTOP_KEYWORDS.includes(normalized)) return 'unstop';
  return 'normal';
}
