import { randomBytes, createHmac, createHash, timingSafeEqual } from 'node:crypto';

const STATE_TTL_MS = 10 * 60 * 1000; // 10 minutes

function base64url(buf: Buffer): string {
  return buf.toString('base64url');
}

function base64urlEncode(str: string): string {
  return Buffer.from(str).toString('base64url');
}

function base64urlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString('utf8');
}

function hmacSign(data: string, secret: string): string {
  return createHmac('sha256', secret).update(data).digest('base64url');
}

export interface CreateStateResult {
  state: string;
  codeVerifier: string;
  codeChallenge: string;
}

export function createState(secret: string): CreateStateResult {
  const codeVerifier = base64url(randomBytes(43));
  const codeChallenge = base64url(createHash('sha256').update(codeVerifier).digest());

  const statePayload = base64urlEncode(JSON.stringify({ cv: codeVerifier, ts: Date.now() }));
  const sig = hmacSign(statePayload, secret);
  const state = `${statePayload}.${sig}`;

  return { state, codeVerifier, codeChallenge };
}

export function verifyState(state: string, secret: string): { codeVerifier: string } {
  const dotIndex = state.indexOf('.');
  if (dotIndex === -1) {
    throw new Error('Invalid state: missing signature');
  }

  const statePayload = state.slice(0, dotIndex);
  const sig = state.slice(dotIndex + 1);

  const expectedSig = hmacSign(statePayload, secret);
  const sigBuf = Buffer.from(sig, 'base64url');
  const expectedBuf = Buffer.from(expectedSig, 'base64url');

  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
    throw new Error('Invalid state: signature mismatch');
  }

  const decoded = JSON.parse(base64urlDecode(statePayload)) as { cv: string; ts: number };

  if (Date.now() - decoded.ts > STATE_TTL_MS) {
    throw new Error('Invalid state: expired');
  }

  return { codeVerifier: decoded.cv };
}
