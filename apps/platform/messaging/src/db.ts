import knex from 'knex';
export type { Knex } from 'knex';

export function createDb(databaseUrl: string): ReturnType<typeof knex> {
  return knex({
    client: 'pg',
    connection: databaseUrl,
    searchPath: ['platform_messaging', 'public'],
  });
}
