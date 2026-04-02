import { describe, it, expect } from 'vitest';
import { getPrompt } from '../../src/services/prompt-registry.js';

describe('prompt-registry', () => {
  it('resolves a known prompt_id to correct definition', () => {
    const prompt = getPrompt('smart-reply-draft');
    expect(prompt).not.toBeNull();
    expect(prompt!.id).toBe('smart-reply-draft');
    expect(prompt!.defaultModel).toBe('haiku');
  });

  it('returns null for unknown prompt_id', () => {
    const prompt = getPrompt('nonexistent-prompt');
    expect(prompt).toBeNull();
  });

  it('conversation-agent-reply has structured: true', () => {
    const prompt = getPrompt('conversation-agent-reply');
    expect(prompt).not.toBeNull();
    expect(prompt!.structured).toBe(true);
  });
});
