import { GetSecretValueCommand, SecretsManagerClient } from '@aws-sdk/client-secrets-manager';

export interface SecretsProvider {
  getSecret(name: string): Promise<string>;
}

export class AwsSecretsProvider implements SecretsProvider {
  private readonly client: SecretsManagerClient;

  constructor() {
    this.client = new SecretsManagerClient({});
  }

  async getSecret(name: string): Promise<string> {
    const result = await this.client.send(
      new GetSecretValueCommand({ SecretId: name }),
    );
    if (!result.SecretString) {
      throw new Error(`Secret "${name}" has no SecretString`);
    }
    return result.SecretString;
  }
}

export class EnvSecretsProvider implements SecretsProvider {
  async getSecret(name: string): Promise<string> {
    const value = process.env[name];
    if (value === undefined) {
      throw new Error(`Environment variable "${name}" is not defined`);
    }
    return value;
  }
}

export function createSecretsProvider(provider: string): SecretsProvider {
  switch (provider) {
    case 'aws':
      return new AwsSecretsProvider();
    case 'env':
      return new EnvSecretsProvider();
    default:
      throw new Error(`Unknown SECRETS_PROVIDER: "${provider}". Expected "aws" or "env".`);
  }
}
