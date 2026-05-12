import { describe, it, expect } from 'vitest';
import { Type } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';

const RenderRequestSchema = Type.Object({
  template_id: Type.String(),
  context: Type.Record(Type.String(), Type.Unknown()),
});

const SmsRenderResponseSchema = Type.Object({
  channel: Type.Literal('sms'),
  body_text: Type.String(),
});

const EmailRenderResponseSchema = Type.Object({
  channel: Type.Literal('email'),
  subject: Type.String(),
  body_html: Type.String(),
  body_text: Type.String(),
});

const ErrorResponseSchema = Type.Object({
  error: Type.String(),
});

describe('RenderRequestSchema', () => {
  it('validates a valid request', () => {
    expect(
      Value.Check(RenderRequestSchema, { template_id: 'some-uuid', context: { first_name: 'Sarah' } }),
    ).toBe(true);
  });

  it('rejects request missing template_id', () => {
    expect(Value.Check(RenderRequestSchema, { context: {} })).toBe(false);
  });

  it('rejects request missing context', () => {
    expect(Value.Check(RenderRequestSchema, { template_id: 'uuid' })).toBe(false);
  });
});

describe('SmsRenderResponseSchema', () => {
  it('validates a valid SMS response', () => {
    expect(Value.Check(SmsRenderResponseSchema, { channel: 'sms', body_text: 'Hi Sarah!' })).toBe(true);
  });

  it('accepts objects with extra fields (open schema)', () => {
    expect(
      Value.Check(SmsRenderResponseSchema, { channel: 'sms', body_text: 'Hi!', extra: 'field' }),
    ).toBe(true);
  });

  it('rejects wrong channel literal', () => {
    expect(Value.Check(SmsRenderResponseSchema, { channel: 'email', body_text: 'x' })).toBe(false);
  });
});

describe('EmailRenderResponseSchema', () => {
  it('validates a valid email response', () => {
    expect(
      Value.Check(EmailRenderResponseSchema, {
        channel: 'email',
        subject: 'Hello Sarah',
        body_html: '<p>Hello Sarah</p>',
        body_text: 'Hello Sarah',
      }),
    ).toBe(true);
  });

  it('rejects email response missing subject', () => {
    expect(
      Value.Check(EmailRenderResponseSchema, {
        channel: 'email',
        body_html: '<p>Hello</p>',
        body_text: 'Hello',
      }),
    ).toBe(false);
  });
});

describe('ErrorResponseSchema', () => {
  it('validates a valid error response', () => {
    expect(
      Value.Check(ErrorResponseSchema, { error: 'Template not found or not renderable' }),
    ).toBe(true);
  });

  it('rejects empty object', () => {
    expect(Value.Check(ErrorResponseSchema, {})).toBe(false);
  });
});
