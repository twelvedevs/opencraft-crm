import { createApp } from '../../src/index.js';
import type { FastifyInstance } from 'fastify';

export async function buildApp(): Promise<FastifyInstance> {
  const fastify = await createApp({ queue: null });
  await fastify.ready();
  return fastify;
}
