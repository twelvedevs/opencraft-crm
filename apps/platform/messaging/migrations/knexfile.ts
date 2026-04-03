import type { Knex } from 'knex';

const config: Record<string, Knex.Config> = {
  development: {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST ?? 'localhost',
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER ?? 'postgres',
      database: process.env.DB_NAME ?? 'ortho',
      password: process.env.DB_PASSWORD ?? 'postgres',
    },
    searchPath: ['platform_messaging', 'public'],
    migrations: {
      directory: '.',
      loadExtensions: ['.ts'],
      schemaName: 'platform_messaging',
      tableName: 'knex_migrations',
    },
  },
  production: {
    client: 'pg',
    connection: {
      host: process.env.DB_HOST,
      port: Number(process.env.DB_PORT ?? 5432),
      user: process.env.DB_USER,
      database: process.env.DB_NAME,
      password: process.env.DB_PASSWORD,
    },
    searchPath: ['platform_messaging', 'public'],
    migrations: {
      directory: '.',
      loadExtensions: ['.ts'],
      schemaName: 'platform_messaging',
      tableName: 'knex_migrations',
    },
  },
};

export default config;
