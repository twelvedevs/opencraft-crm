import { describe, it, expect } from 'vitest';
import { parseAgentResponse, buildDisclosureFooter } from '../../src/services/agent-mode.js';

describe('agent-mode', () => {
  describe('parseAgentResponse', () => {
    it('returns parsed object for valid JSON with text and escalate: false', () => {
      const input = JSON.stringify({ text: 'Hello!', escalate: false });
      const result = parseAgentResponse(input);
      expect(result).toEqual({ text: 'Hello!', escalate: false, reason: undefined });
    });

    it('returns parsed object for escalate: true', () => {
      const input = JSON.stringify({ text: '', escalate: true, reason: 'needs human' });
      const result = parseAgentResponse(input);
      expect(result).toEqual({ text: '', escalate: true, reason: 'needs human' });
    });

    it('returns null for invalid JSON (fail-safe escalation)', () => {
      const result = parseAgentResponse('not json at all');
      expect(result).toBeNull();
    });

    it('returns null for non-object JSON', () => {
      const result = parseAgentResponse('"just a string"');
      expect(result).toBeNull();
    });
  });

  describe('buildDisclosureFooter', () => {
    it('includes location_phone in message', () => {
      const footer = buildDisclosureFooter('+15551234567');
      expect(footer).toContain('+15551234567');
    });

    it('includes STOP instructions', () => {
      const footer = buildDisclosureFooter('+15551234567');
      expect(footer).toContain('STOP');
    });
  });
});
