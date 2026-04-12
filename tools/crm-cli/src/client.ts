import { resolveToken, readConfig } from './config.js';

export interface RequestOptions {
  method?: string;
  body?: unknown;
  token?: string;
  gatewayUrl?: string;
}

export class ApiError extends Error {
  constructor(public status: number, public apiError: string) {
    super(`HTTP ${status}: ${apiError}`);
    this.name = 'ApiError';
  }
}

export class NetworkError extends Error {
  constructor(url: string) {
    super(`Cannot reach gateway at ${url}. Is the stack running?`);
    this.name = 'NetworkError';
  }
}

export async function request(path: string, options: RequestOptions = {}): Promise<unknown> {
  const config = readConfig();
  const baseUrl = options.gatewayUrl ?? config.gateway_url;
  const token   = resolveToken(options.token);
  const url     = `${baseUrl}/v1${path}`;

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;

  let response: Response;
  try {
    response = await fetch(url, {
      method: options.method ?? 'GET',
      headers,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
    });
  } catch {
    throw new NetworkError(baseUrl);
  }

  const data = await response.json().catch(() => ({}));

  if (!response.ok) {
    const body = data as { error?: string };
    if (response.status === 401) {
      throw new ApiError(401, `${body.error ?? 'unauthorized'} — Token may be expired. Run 'crm login'`);
    }
    if (response.status >= 500) {
      throw new ApiError(response.status, `Server error (${response.status}). Check service logs.`);
    }
    throw new ApiError(response.status, body.error ?? response.statusText);
  }

  return data;
}
