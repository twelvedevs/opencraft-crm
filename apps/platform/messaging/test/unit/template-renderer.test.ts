import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../../src/services/template-renderer.js';

describe('renderTemplate', () => {
  it('replaces a simple merge tag', () => {
    expect(renderTemplate('Hello {{first_name}}', { first_name: 'Sara' }))
      .toBe('Hello Sara');
  });

  it('replaces multiple tags in one template', () => {
    const result = renderTemplate(
      '{{first_name}} {{last_name}}, welcome!',
      { first_name: 'Sara', last_name: 'Jones' },
    );
    expect(result).toBe('Sara Jones, welcome!');
  });

  it('renders missing keys as empty string', () => {
    expect(renderTemplate('Hi {{first_name}} {{last_name}}', { first_name: 'Sara' }))
      .toBe('Hi Sara ');
  });

  it('returns template unchanged when there are no tags', () => {
    expect(renderTemplate('No tags here', { first_name: 'Sara' }))
      .toBe('No tags here');
  });

  it('returns empty string for empty template', () => {
    expect(renderTemplate('', { first_name: 'Sara' })).toBe('');
  });

  it('passes through pre-rendered body with no tags unchanged', () => {
    const body = 'Your appointment is at 3pm tomorrow.';
    expect(renderTemplate(body, {})).toBe(body);
  });
});
