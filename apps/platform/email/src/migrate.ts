import knex from 'knex';

const DATABASE_URL = process.env['DATABASE_URL'];
if (!DATABASE_URL) {
  throw new Error('Missing required env: DATABASE_URL');
}

const db = knex({ client: 'pg', connection: DATABASE_URL });

try {
  const result = await db.migrate.latest({ directory: 'migrations' });
  console.log('Migration completed:', result);
} finally {
  await db.destroy();
}
