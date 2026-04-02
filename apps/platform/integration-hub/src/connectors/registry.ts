import type { Connector } from './interface.js';

export const ConnectorRegistry = new Map<string, Connector>();

export function getConnector(platform: string): Connector {
  const connector = ConnectorRegistry.get(platform);
  if (!connector) {
    throw Object.assign(
      new Error(`Unknown platform: ${platform}`),
      { statusCode: 400 },
    );
  }
  return connector;
}
