import fp from 'fastify-plugin';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import type { FastifyPluginAsync } from 'fastify';

export interface OpenApiPluginOptions {
  title: string;
  description?: string;
  version?: string;
  tags?: Array<{ name: string; description?: string }>;
}

const plugin: FastifyPluginAsync<OpenApiPluginOptions> = async (fastify, opts) => {
  if (process.env['NODE_ENV'] === 'production') return;

  await fastify.register(swagger, {
    openapi: {
      openapi: '3.0.0',
      info: {
        title: opts.title,
        description: opts.description ?? '',
        version: opts.version ?? '1.0.0',
      },
      tags: opts.tags ?? [],
      components: {
        securitySchemes: {
          BearerAuth: {
            type: 'http',
            scheme: 'bearer',
            bearerFormat: 'JWT',
          },
        },
      },
      security: [{ BearerAuth: [] }],
    },
  });

  await fastify.register(swaggerUi, {
    routePrefix: '/docs',
  });

  fastify.get('/openapi.json', { schema: { hide: true } }, async (_req, reply) => {
    return reply.send(fastify.swagger());
  });
};

export const openapiPlugin = fp(plugin, {
  name: '@ortho/openapi',
  fastify: '5.x',
});
