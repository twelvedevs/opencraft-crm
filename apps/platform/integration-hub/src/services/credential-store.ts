import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 12;
const TAG_LENGTH = 16;

export function encrypt(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  const payload = JSON.stringify({
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    tag: tag.toString('hex'),
  });

  return Buffer.from(payload).toString('base64');
}

export function decrypt(stored: string, key: Buffer): string {
  let parsed: { iv?: string; ciphertext?: string; tag?: string };
  try {
    parsed = JSON.parse(Buffer.from(stored, 'base64').toString('utf8')) as {
      iv?: string;
      ciphertext?: string;
      tag?: string;
    };
  } catch {
    throw new Error('Credential decryption failed: malformed stored value');
  }

  if (!parsed.iv || !parsed.ciphertext || !parsed.tag) {
    throw new Error('Credential decryption failed: missing iv, ciphertext, or tag');
  }

  const iv = Buffer.from(parsed.iv, 'hex');
  const ciphertext = Buffer.from(parsed.ciphertext, 'hex');
  const tag = Buffer.from(parsed.tag, 'hex');

  const decipher = createDecipheriv(ALGORITHM, key, iv, { authTagLength: TAG_LENGTH });
  decipher.setAuthTag(tag);

  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return plaintext.toString('utf8');
  } catch {
    throw new Error('Credential decryption failed: wrong key or tampered ciphertext');
  }
}
