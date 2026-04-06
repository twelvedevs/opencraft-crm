import knexLib from 'knex';
import { env } from './env.js';

const knex = knexLib({
  client: 'pg',
  connection: env.DATABASE_URL,
  searchPath: ['crm_leads', 'public'],
});

export default knex;

export function destroy(): Promise<void> {
  return knex.destroy();
}
