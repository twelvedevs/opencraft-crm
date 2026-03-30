function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

export const config = {
  DATABASE_URL: requireEnv('DATABASE_URL'),
  REDIS_URL: requireEnv('REDIS_URL'),
  JWT_HMAC_SECRET: requireEnv('JWT_HMAC_SECRET'),
  PORT: parseInt(process.env['PORT'] ?? '3006', 10),
};
