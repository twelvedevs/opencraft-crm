import Fastify, { type FastifyBaseLogger } from 'fastify';
import sensible from '@fastify/sensible';
import { authPlugin } from '@ortho/auth-middleware';
import { openapiPlugin } from '@ortho/openapi';
import { createLogger } from '@ortho/logger';
import db, { destroy } from './db.js';
import { env } from './env.js';

// Public routes
import { publicLinksRoutes } from './routes/public/links.js';
import { publicPortalRoutes } from './routes/public/portal.js';

// Staff routes
import { referrersRoutes } from './routes/referrers.js';
import { referralLinksRoutes } from './routes/referral-links.js';
import { referralsRoutes } from './routes/referrals.js';
import { rewardsRoutes } from './routes/rewards.js';
import { leaderboardRoutes } from './routes/leaderboard.js';

const log = createLogger('crm-referral');
const app = Fastify({ loggerInstance: log as unknown as FastifyBaseLogger });

await app.register(sensible);

await app.register(openapiPlugin, {
  title: 'Referral Service',
  description: 'Referral link generation, click tracking, and conversion attribution',
  tags: [
    { name: 'Referrals', description: 'Referral records' },
    { name: 'Referrers', description: 'Referring doctor and patient management' },
    { name: 'Referral Links', description: 'Unique referral link management' },
    { name: 'Rewards', description: 'Referral reward tracking' },
    { name: 'Leaderboard', description: 'Top referrers leaderboard' },
    { name: 'Public', description: 'Public referral link endpoints' },
  ],
});

app.get('/health', { schema: { hide: true } as object }, async () => ({ ok: true }));

// Public routes — encapsulated scope, no auth
await app.register(async (scope) => {
  await scope.register(publicLinksRoutes, { db });
  await scope.register(publicPortalRoutes, { db });
});

// Staff routes — encapsulated scope with auth
await app.register(async (scope) => {
  await scope.register(authPlugin, { jwksUrl: env.IDENTITY_JWKS_URL });

  await scope.register(referrersRoutes, { prefix: '/referrals/referrers', db });
  await scope.register(referralLinksRoutes, { prefix: '/referrals', db });
  await scope.register(referralsRoutes, { prefix: '/referrals', db });
  await scope.register(rewardsRoutes, { prefix: '/referrals', db });
  await scope.register(leaderboardRoutes, { prefix: '/referrals', db });
});

await app.listen({ port: env.PORT, host: '0.0.0.0' });

process.on('SIGTERM', async () => {
  await app.close();
  await destroy();
  process.exit(0);
});
