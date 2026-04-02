import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

export interface JwtPayload {
  sub: string;
  role: string;
  locations: string[];
  must_change_password: boolean;
}

declare module 'fastify' {
  interface FastifyRequest {
    user: JwtPayload;
  }
}

// Stub plugin — full implementation in US-013
export async function authPlugin(_app: FastifyInstance, _opts: unknown): Promise<void> {
  // No-op stub; real JWT verification added in US-013
}
