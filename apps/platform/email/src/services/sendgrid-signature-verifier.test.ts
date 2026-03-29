import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { SendgridSignatureVerifier } from './sendgrid-signature-verifier.js';

// Generate a real EC key pair once for the test suite
const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'prime256v1',
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

const mockSend = vi.fn();

vi.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: vi.fn(() => ({ send: mockSend })),
  GetSecretValueCommand: vi.fn((input: unknown) => input),
}));

function signPayload(rawBody: string, timestamp: string): string {
  const signer = createSign('SHA256');
  signer.update(rawBody + timestamp);
  return signer.sign(privateKey, 'base64');
}

const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:sendgrid-key';
const rawBody = '[{"event":"delivered"}]';
const timestamp = '1711720000';

describe('SendgridSignatureVerifier', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockSend.mockResolvedValue({ SecretString: publicKey });
  });

  it('valid signature returns true', async () => {
    const verifier = new SendgridSignatureVerifier(SECRET_ARN);
    const signature = signPayload(rawBody, timestamp);

    const result = await verifier.verify({ rawBody, signature, timestamp });

    expect(result).toBe(true);
  });

  it('invalid signature returns false', async () => {
    const verifier = new SendgridSignatureVerifier(SECRET_ARN);

    const result = await verifier.verify({ rawBody, signature: 'bm90YXZhbGlkc2ln', timestamp });

    expect(result).toBe(false);
  });

  it('Secrets Manager throws returns false', async () => {
    mockSend.mockRejectedValue(new Error('AccessDeniedException'));
    const verifier = new SendgridSignatureVerifier(SECRET_ARN);
    const signature = signPayload(rawBody, timestamp);

    const result = await verifier.verify({ rawBody, signature, timestamp });

    expect(result).toBe(false);
  });

  it('second call reuses cached key — SecretsManager send called exactly once', async () => {
    const verifier = new SendgridSignatureVerifier(SECRET_ARN);
    const signature = signPayload(rawBody, timestamp);

    await verifier.verify({ rawBody, signature, timestamp });
    await verifier.verify({ rawBody, signature, timestamp });

    expect(mockSend).toHaveBeenCalledTimes(1);
  });
});
