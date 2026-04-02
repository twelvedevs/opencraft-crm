import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encrypt, decrypt } from '../../src/services/credential-store.js';

describe('credential-store', () => {
  const key = randomBytes(32);

  it('encrypt → decrypt round-trip produces original plaintext', () => {
    const plaintext = 'my-secret-oauth-token-12345';
    const stored = encrypt(plaintext, key);
    const result = decrypt(stored, key);
    expect(result).toBe(plaintext);
  });

  it('two calls to encrypt with same plaintext produce different IVs', () => {
    const plaintext = 'same-value';
    const a = encrypt(plaintext, key);
    const b = encrypt(plaintext, key);
    expect(a).not.toBe(b);

    // Parse to verify IVs differ
    const parsedA = JSON.parse(Buffer.from(a, 'base64').toString('utf8'));
    const parsedB = JSON.parse(Buffer.from(b, 'base64').toString('utf8'));
    expect(parsedA.iv).not.toBe(parsedB.iv);
  });

  it('decrypting with wrong key throws', () => {
    const stored = encrypt('secret', key);
    const wrongKey = randomBytes(32);
    expect(() => decrypt(stored, wrongKey)).toThrow('wrong key or tampered ciphertext');
  });

  it('decrypting tampered ciphertext throws', () => {
    const stored = encrypt('secret', key);
    const parsed = JSON.parse(Buffer.from(stored, 'base64').toString('utf8'));
    // Flip a byte in the ciphertext
    const ct = Buffer.from(parsed.ciphertext, 'hex');
    ct[0] ^= 0xff;
    parsed.ciphertext = ct.toString('hex');
    const tampered = Buffer.from(JSON.stringify(parsed)).toString('base64');
    expect(() => decrypt(tampered, key)).toThrow('wrong key or tampered ciphertext');
  });

  it('decrypting malformed base64 throws', () => {
    expect(() => decrypt('not-valid-json!!!', key)).toThrow('malformed stored value');
  });

  it('decrypting value with missing fields throws', () => {
    const incomplete = Buffer.from(JSON.stringify({ iv: 'aa' })).toString('base64');
    expect(() => decrypt(incomplete, key)).toThrow('missing iv, ciphertext, or tag');
  });
});
