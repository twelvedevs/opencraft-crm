import { describe, it, expect } from 'vitest';
import { formatImportStatus, formatCount } from '../src/commands/imports.js';

describe('formatImportStatus', () => {
  it('colors completed green', () => {
    expect(formatImportStatus('completed')).toContain('completed');
  });
  it('colors failed red', () => {
    expect(formatImportStatus('failed')).toContain('failed');
  });
  it('passes through unknown status unchanged', () => {
    expect(formatImportStatus('preview_ready')).toContain('preview_ready');
  });
});

describe('formatCount', () => {
  it('returns em-dash for null', () => {
    expect(formatCount(null)).toBe('—');
  });
  it('returns number as string', () => {
    expect(formatCount(42)).toBe('42');
  });
});
