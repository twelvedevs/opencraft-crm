import { createVerify } from 'node:crypto';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export class SendgridSignatureVerifier {
  private readonly client: SecretsManagerClient;
  private cachedPublicKey: string | null = null;

  constructor(private readonly secretArn: string) {
    this.client = new SecretsManagerClient({});
  }

  private async getPublicKey(): Promise<string> {
    if (this.cachedPublicKey !== null) {
      return this.cachedPublicKey;
    }
    const response = await this.client.send(
      new GetSecretValueCommand({ SecretId: this.secretArn }),
    );
    const key = response.SecretString;
    if (!key) {
      throw new Error('Secret value is empty');
    }
    this.cachedPublicKey = key;
    return key;
  }

  async verify(opts: { rawBody: string; signature: string; timestamp: string }): Promise<boolean> {
    try {
      const publicKey = await this.getPublicKey();
      const verifier = createVerify('SHA256');
      verifier.update(opts.rawBody + opts.timestamp);
      return verifier.verify(publicKey, opts.signature, 'base64');
    } catch {
      return false;
    }
  }
}
