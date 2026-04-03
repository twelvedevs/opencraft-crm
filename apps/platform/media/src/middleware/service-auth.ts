import { type FastifyReply, type FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../env.js';

export const serviceAuthHook = async (
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<void> => {
  const header = request.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }

  const token = header.slice(7);
  const expected = env.SERVICE_AUTH_TOKEN;

  const tokenBuf = Buffer.from(token);
  const expectedBuf = Buffer.from(expected);

  if (tokenBuf.length !== expectedBuf.length || !timingSafeEqual(tokenBuf, expectedBuf)) {
    reply.code(401).send({ error: 'Unauthorized' });
    return;
  }
};
