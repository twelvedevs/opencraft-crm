import { describe, it, expect, vi, afterEach } from 'vitest';
import { createState, verifyState } from '../../src/services/oauth-state.js';

describe('oauth-state', () => {
  const secret = 'test-secret-key-for-hmac';

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('createState returns state, codeVerifier, and codeChallenge', () => {
    const result = createState(secret);
    expect(result).toHaveProperty('state');
    expect(result).toHaveProperty('codeVerifier');
    expect(result).toHaveProperty('codeChallenge');
    expect(typeof result.state).toBe('string');
    expect(result.state).toContain('.');
  });

  it('verifyState on unmodified state returns matching codeVerifier', () => {
    const { state, codeVerifier } = createState(secret);
    const result = verifyState(state, secret);
    expect(result.codeVerifier).toBe(codeVerifier);
  });

  it('verifyState on tampered signature throws', () => {
    const { state } = createState(secret);
    const [payload] = state.split('.');
    const tampered = `${payload}.tampered-signature`;
    expect(() => verifyState(tampered, secret)).toThrow('signature mismatch');
  });

  it('verifyState on tampered payload throws', () => {
    const { state } = createState(secret);
    const [, sig] = state.split('.');
    const tampered = `tampered-payload.${sig}`;
    expect(() => verifyState(tampered, secret)).toThrow('signature mismatch');
  });

  it('verifyState with wrong secret throws', () => {
    const { state } = createState(secret);
    expect(() => verifyState(state, 'wrong-secret')).toThrow('signature mismatch');
  });

  it('verifyState on state older than 10 minutes throws', () => {
    const { state } = createState(secret);

    // Advance time by 11 minutes
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 11 * 60 * 1000);

    expect(() => verifyState(state, secret)).toThrow('expired');
  });

  it('verifyState on state missing signature throws', () => {
    expect(() => verifyState('no-dot-here', secret)).toThrow('missing signature');
  });

  it('state just under 10 minutes is still valid', () => {
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now);
    const { state, codeVerifier } = createState(secret);

    // 9 minutes 59 seconds later
    vi.spyOn(Date, 'now').mockReturnValue(now + 9 * 60 * 1000 + 59 * 1000);
    const result = verifyState(state, secret);
    expect(result.codeVerifier).toBe(codeVerifier);
  });
});
