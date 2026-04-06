import crypto from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../env.js';

export const serviceAuthHook = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const authHeader = request.headers.authorization;

  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  const token = authHeader.slice(7);
  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(env.SERVICE_AUTH_TOKEN);

  if (tokenBuf.length !== expectedBuf.length || !crypto.timingSafeEqual(tokenBuf, expectedBuf)) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }
};
