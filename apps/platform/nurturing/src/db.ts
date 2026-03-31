import knex, { type Knex } from 'knex';

export function createDb(): Knex {
  const connectionString = process.env['DATABASE_URL'];
  if (!connectionString) throw new Error('DATABASE_URL is required');
  return knex({
    client: 'pg',
    connection: connectionString,
    searchPath: ['platform_nurturing', 'public'],
  });
}
