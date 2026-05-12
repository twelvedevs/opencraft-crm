import { config } from '../config.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
const VALID_CHANNELS = [
  'google_ads',
  'facebook',
  'website',
  'referral_patient',
  'referral_doctor',
  'call_tracking',
  'walk_in',
  'chat',
  'google_business',
  'import',
  'unknown',
] as const;

type Channel = (typeof VALID_CHANNELS)[number];

export type ResolveChannelResult =
  | { ok: true; channel: Channel }
  | { ok: false; error: 'lead_not_found' | 'upstream_unavailable' | 'channel_resolution_failed' };

function isValidChannel(value: unknown): value is Channel {
  return typeof value === 'string' && (VALID_CHANNELS as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// Resolver
// ---------------------------------------------------------------------------

/**
 * Fetch the attribution channel for a lead from the Lead Service.
 *
 * Returns a discriminated union result — callers must handle all error cases
 * before forwarding to Pipeline Engine.
 */
export async function resolveChannel(leadId: string): Promise<ResolveChannelResult> {
  let response: Response;

  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), config.UPSTREAM_TIMEOUT_MS);

    try {
      response = await fetch(`${config.LEAD_SERVICE_URL}/leads/${encodeURIComponent(leadId)}`, {
        headers: {
          Authorization: `Bearer ${config.LEAD_SERVICE_API_KEY}`,
        },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch {
    // Network error or timeout
    return { ok: false, error: 'upstream_unavailable' };
  }

  if (response.status === 404) {
    return { ok: false, error: 'lead_not_found' };
  }

  if (response.status >= 500) {
    return { ok: false, error: 'upstream_unavailable' };
  }

  // Attempt to parse the response body
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return { ok: false, error: 'channel_resolution_failed' };
  }

  if (
    body === null ||
    typeof body !== 'object' ||
    !('channel' in body) ||
    !isValidChannel((body as Record<string, unknown>)['channel'])
  ) {
    return { ok: false, error: 'channel_resolution_failed' };
  }

  return { ok: true, channel: (body as Record<string, unknown>)['channel'] as Channel };
}
