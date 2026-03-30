import { describe, it, expect } from 'vitest';
import { renderString } from '../../src/services/template-renderer.js';

describe('renderString', () => {
  it('happy path: all tags resolved', () => {
    const result = renderString('Hello {{first_name}}!', { first_name: 'Alice' });
    expect(result).toEqual({ ok: true, value: 'Hello Alice!', warnings: [] });
  });

  it('dot-notation path: {{lead.first_name}}', () => {
    const result = renderString('Hi {{lead.first_name}}', { lead: { first_name: 'Bob' } });
    expect(result).toEqual({ ok: true, value: 'Hi Bob', warnings: [] });
  });

  it('missing key: replaced with empty string, warning added', () => {
    const result = renderString('Hello {{unknown_key}}!', {});
    expect(result).toEqual({ ok: true, value: 'Hello !', warnings: ['unknown_key'] });
  });

  it('nested context object resolved correctly', () => {
    const result = renderString('{{a.b.c}}', { a: { b: { c: 'deep' } } });
    expect(result).toEqual({ ok: true, value: 'deep', warnings: [] });
  });

  it('no merge tags: returned unchanged', () => {
    const result = renderString('No tags here.', {});
    expect(result).toEqual({ ok: true, value: 'No tags here.', warnings: [] });
  });

  it('multiple occurrences of same tag all replaced', () => {
    const result = renderString('{{name}} and {{name}}', { name: 'Charlie' });
    expect(result).toEqual({ ok: true, value: 'Charlie and Charlie', warnings: [] });
  });

  it('case-insensitive: {{First_Name}} resolves first_name', () => {
    const result = renderString('Hello {{First_Name}}', { first_name: 'Dana' });
    expect(result).toEqual({ ok: true, value: 'Hello Dana', warnings: [] });
  });

  it('malformed unclosed {{ → ok:false error result', () => {
    const result = renderString('Hello {{ world', {});
    expect(result).toEqual({ ok: false, error: 'Malformed merge tag in template content' });
  });

  it('empty tag {{ }} → ok:false error result', () => {
    const result = renderString('Hello {{ }}', {});
    expect(result).toEqual({ ok: false, error: 'Malformed merge tag in template content' });
  });

  it('array index path treated as unknown key: empty string + warning', () => {
    const result = renderString('{{appointments.0.date}}', { appointments: [{ date: '2026-01-01' }] });
    expect(result).toEqual({ ok: true, value: '', warnings: ['appointments.0.date'] });
  });
});
