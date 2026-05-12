import { jwtVerify } from 'jose';
import type { FastifyRequest, FastifyReply } from 'fastify';

export interface JwtClaims {
  sub: string;
  roles?: string[];
}

export async function verifyJwt(
  authHeader: string | undefined,
  secret: string,
): Promise<JwtClaims> {
  if (!authHeader) {
    throw { statusCode: 401, message: 'Unauthorized' };
  }

  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  const secretKey = new TextEncoder().encode(secret);

  try {
    const { payload } = await jwtVerify(token, secretKey, { algorithms: ['HS256'] });
    return payload as unknown as JwtClaims;
  } catch {
    throw { statusCode: 401, message: 'Invalid token' };
  }
}

export function isServiceApiKey(authHeader: string | undefined): boolean {
  if (!authHeader) return false;
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;
  return token.startsWith('ak_');
}

export function requireAuth(
  secret: string,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authHeader = request.headers.authorization;

    if (isServiceApiKey(authHeader)) {
      return;
    }

    try {
      await verifyJwt(authHeader, secret);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      const status = e.statusCode ?? 401;
      const message = e.message ?? 'Unauthorized';
      return reply.status(status).send({ statusCode: status, error: 'Unauthorized', message });
    }
  };
}

export function requireRole(
  role: string,
  secret: string,
): (request: FastifyRequest, reply: FastifyReply) => Promise<void> {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const authHeader = request.headers.authorization;

    let claims: JwtClaims;
    try {
      claims = await verifyJwt(authHeader, secret);
    } catch (err: unknown) {
      const e = err as { statusCode?: number; message?: string };
      const status = e.statusCode ?? 401;
      const message = e.message ?? 'Unauthorized';
      return reply.status(status).send({ statusCode: status, error: 'Unauthorized', message });
    }

    if (!claims.roles?.includes(role)) {
      return reply.status(403).send({ statusCode: 403, error: 'Forbidden', message: 'Forbidden' });
    }
  };
}
