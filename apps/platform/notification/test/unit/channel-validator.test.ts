import { describe, it, expect } from 'vitest';
import {
  validateChannelPattern,
  validateChannelAccess,
  ALL_CHANNEL_PREFIXES,
} from '../../src/services/channel-validator.js';

describe('validateChannelPattern', () => {
  describe('accepted patterns', () => {
    it('accepts location:{id}:{type}', () => {
      expect(validateChannelPattern('location:abc123:inbound_sms')).toBe(true);
      expect(validateChannelPattern('location:uuid-goes-here:escalation')).toBe(true);
    });

    it('accepts user:{id}:{type}', () => {
      expect(validateChannelPattern('user:xyz789:task')).toBe(true);
      expect(validateChannelPattern('user:some-user-id:reminder')).toBe(true);
    });

    it('accepts global:system exactly', () => {
      expect(validateChannelPattern('global:system')).toBe(true);
    });
  });

  describe('rejected patterns', () => {
    it('rejects empty string', () => {
      expect(validateChannelPattern('')).toBe(false);
    });

    it('rejects unknown prefix', () => {
      expect(validateChannelPattern('unknown:xyz')).toBe(false);
      expect(validateChannelPattern('other:abc:def')).toBe(false);
    });

    it('rejects bare strings with no colon', () => {
      expect(validateChannelPattern('location')).toBe(false);
      expect(validateChannelPattern('user')).toBe(false);
      expect(validateChannelPattern('global')).toBe(false);
      expect(validateChannelPattern('notifications')).toBe(false);
    });

    it('rejects location with missing segments', () => {
      expect(validateChannelPattern('location:')).toBe(false);
      expect(validateChannelPattern('location:abc')).toBe(false);
    });

    it('rejects user with missing segments', () => {
      expect(validateChannelPattern('user:')).toBe(false);
      expect(validateChannelPattern('user:abc')).toBe(false);
    });

    it('rejects extra colons producing empty segments', () => {
      expect(validateChannelPattern('location::type')).toBe(false);
      expect(validateChannelPattern('location:id:')).toBe(false);
      expect(validateChannelPattern('location:id:type:')).toBe(false);
      expect(validateChannelPattern('user::type')).toBe(false);
    });

    it('rejects global with non-system suffix', () => {
      expect(validateChannelPattern('global:other')).toBe(false);
      expect(validateChannelPattern('global:system:extra')).toBe(false);
    });
  });
});

describe('ALL_CHANNEL_PREFIXES', () => {
  it('includes location, user, global', () => {
    expect(ALL_CHANNEL_PREFIXES).toContain('location');
    expect(ALL_CHANNEL_PREFIXES).toContain('user');
    expect(ALL_CHANNEL_PREFIXES).toContain('global');
  });
});

describe('validateChannelAccess', () => {
  const claims = { sub: 'user-42', locations: ['loc-1', 'loc-2'] };

  it('allows global:system for any authenticated user', () => {
    expect(validateChannelAccess('global:system', { sub: 'anyone' })).toBe(true);
    expect(validateChannelAccess('global:system', { sub: 'anyone', locations: [] })).toBe(true);
  });

  it('allows location channel when location is in JWT claims', () => {
    expect(validateChannelAccess('location:loc-1:inbound_sms', claims)).toBe(true);
    expect(validateChannelAccess('location:loc-2:escalation', claims)).toBe(true);
  });

  it('denies location channel when location is not in JWT claims', () => {
    expect(validateChannelAccess('location:loc-999:inbound_sms', claims)).toBe(false);
  });

  it('denies location channel when locations claim is absent', () => {
    expect(validateChannelAccess('location:loc-1:inbound_sms', { sub: 'user-42' })).toBe(false);
  });

  it('allows user channel when sub matches', () => {
    expect(validateChannelAccess('user:user-42:task', claims)).toBe(true);
  });

  it('denies user channel when sub does not match', () => {
    expect(validateChannelAccess('user:other-user:task', claims)).toBe(false);
  });
});
