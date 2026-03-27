import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

export function createSecretsResolver(): (key: string) => Promise<string> {
  const client = new SecretsManagerClient({});
  return async (key: string): Promise<string> => {
    const response = await client.send(new GetSecretValueCommand({ SecretId: key }));
    if (!response.SecretString) {
      throw new Error('Secret not found or has no string value: ' + key);
    }
    return response.SecretString;
  };
}
