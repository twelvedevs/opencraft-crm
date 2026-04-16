import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
import type { Logger } from '@ortho/logger';

export interface RequestLoggingPluginOptions {
  /** Logger instance from @ortho/logger — injected, not created internally */
  logger: Logger;
  /** Body truncation ceiling in bytes. Default: 10 240 (10 KB) */
  maxBodySize?: number;
}

declare module 'fastify' {
  interface FastifyContextConfig {
    /** Set to true on a route to suppress onRequest/onResponse logging for that route */
    disableRequestLogging?: boolean;
    /** Set to true on a route to bypass auth middleware (used by @ortho/auth-middleware) */
    skipAuth?: boolean;
  }
  interface FastifyRequest {
    _loggingStartTime?: number;
  }
}

const DEFAULT_MAX_BODY_SIZE = 10 * 1024;

function truncateBody(body: unknown, maxSize: number): string {
  const bodyStr = typeof body === 'string' ? body : JSON.stringify(body);
  const byteLength = Buffer.byteLength(bodyStr, 'utf8');
  if (byteLength <= maxSize) return bodyStr;
  return `${bodyStr.substring(0, maxSize)}... [truncated: ${byteLength} bytes total]`;
}

function loggingPlugin(
  fastify: FastifyInstance,
  options: RequestLoggingPluginOptions,
): void {
  const { logger, maxBodySize = DEFAULT_MAX_BODY_SIZE } = options;

  fastify.decorateRequest('_loggingStartTime', undefined);

  fastify.addHook(
    'onRequest',
    (request: FastifyRequest, _reply: FastifyReply, done: () => void) => {
      if (request.routeOptions?.config?.disableRequestLogging) return done();
      request._loggingStartTime = Date.now();
      logger.info({
        msg: 'incoming request',
        method: request.method,
        url: request.url,
        userAgent: request.headers['user-agent'],
        timestamp: new Date().toISOString(),
      });
      done();
    },
  );

  fastify.addHook(
    'onResponse',
    (request: FastifyRequest, reply: FastifyReply, done: () => void) => {
      if (request.routeOptions?.config?.disableRequestLogging) return done();
      const startTime = request._loggingStartTime;
      const durationMs = startTime !== undefined ? Date.now() - startTime : undefined;
      const contentLength = reply.getHeader('content-length');
      const responseSize =
        typeof contentLength === 'string' || typeof contentLength === 'number'
          ? Number(contentLength)
          : undefined;
      const logData: Record<string, unknown> = {
        msg: 'outgoing response',
        statusCode: reply.statusCode,
        durationMs,
        responseSize,
      };
      if (reply.statusCode >= 400 && request.body !== undefined) {
        logData.requestBody = truncateBody(request.body, maxBodySize);
      }
      logger.info(logData);
      done();
    },
  );

  fastify.addHook(
    'onError',
    (request: FastifyRequest, reply: FastifyReply, error: Error, done: () => void) => {
      const startTime = request._loggingStartTime;
      const durationMs = startTime !== undefined ? Date.now() - startTime : undefined;
      const logData: Record<string, unknown> = {
        msg: 'request error',
        error: { name: error.name, message: error.message, stack: error.stack },
        method: request.method,
        url: request.url,
        statusCode: reply.statusCode,
        durationMs,
      };
      if (request.body !== undefined) {
        logData.requestBody = truncateBody(request.body, maxBodySize);
      }
      logger.error(logData);
      done();
    },
  );
}

export const requestLoggingPlugin = fp(loggingPlugin, {
  name: 'ortho-request-logging',
  fastify: '5.x',
});
