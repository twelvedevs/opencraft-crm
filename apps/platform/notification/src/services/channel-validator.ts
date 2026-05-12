export const ALL_CHANNEL_PREFIXES = ['location', 'user', 'global'] as const;

/**
 * Validates that a channel string matches one of the accepted patterns:
 * - location:{id}:{type}  — non-empty id and type, no empty segments
 * - user:{id}:{type}      — non-empty id and type, no empty segments
 * - global:system         — exact match only
 */
export function validateChannelPattern(channel: string): boolean {
  if (!channel) return false;

  const parts = channel.split(':');

  // Reject any empty segment (catches trailing colon, double colon, etc.)
  if (parts.some((p) => p === '')) return false;

  const [prefix, ...rest] = parts;

  if (prefix === 'global') {
    // Only "global:system" is accepted
    return rest.length === 1 && rest[0] === 'system';
  }

  if (prefix === 'location' || prefix === 'user') {
    // Must have exactly prefix + id + type (3 segments total)
    return rest.length === 2;
  }

  return false;
}

export interface JwtClaims {
  sub: string;
  locations?: string[];
}

/**
 * Validates that the authenticated principal (from JWT claims) is allowed to
 * subscribe to or publish on the given channel.
 *
 * Assumes validateChannelPattern(channel) === true.
 */
export function validateChannelAccess(channel: string, jwtClaims: JwtClaims): boolean {
  const [prefix, id] = channel.split(':');

  if (prefix === 'global') return true;

  if (prefix === 'location') {
    return Array.isArray(jwtClaims.locations) && jwtClaims.locations.includes(id!);
  }

  if (prefix === 'user') {
    return jwtClaims.sub === id;
  }

  return false;
}
