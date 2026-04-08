import { env } from '../env.js';

export interface ServiceClient {
  post<T>(path: string, body: unknown): Promise<T>;
  get<T>(path: string, params?: Record<string, string>): Promise<T>;
}

export interface ServiceError {
  status: number;
  body: unknown;
}

function isServiceError(err: unknown): err is ServiceError {
  return typeof err === 'object' && err !== null && 'status' in err && 'body' in err;
}

export function createServiceClient(baseUrl: string, apiKey: string): ServiceClient {
  async function request<T>(method: string, path: string, body?: unknown, params?: Record<string, string>): Promise<T> {
    let url = baseUrl + path;
    if (params && Object.keys(params).length > 0) {
      const qs = new URLSearchParams(params);
      url += '?' + qs.toString();
    }

    const headers: Record<string, string> = {
      'X-Internal-Api-Key': apiKey,
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      let responseBody: unknown;
      try {
        responseBody = await res.json();
      } catch {
        responseBody = await res.text();
      }
      const err: ServiceError = { status: res.status, body: responseBody };
      throw err;
    }

    return (await res.json()) as T;
  }

  return {
    post<T>(path: string, body: unknown): Promise<T> {
      return request<T>('POST', path, body);
    },
    get<T>(path: string, params?: Record<string, string>): Promise<T> {
      return request<T>('GET', path, undefined, params);
    },
  };
}

export const messagingClient = createServiceClient(env.MESSAGING_SERVICE_URL, env.INTERNAL_API_KEY);
export const leadClient = createServiceClient(env.LEAD_SERVICE_URL, env.INTERNAL_API_KEY);
export const aiClient = createServiceClient(env.AI_SERVICE_URL, env.INTERNAL_API_KEY);
export const audienceClient = createServiceClient(env.AUDIENCE_ENGINE_URL, env.INTERNAL_API_KEY);
export const notificationClient = createServiceClient(env.NOTIFICATION_SERVICE_URL, env.INTERNAL_API_KEY);
