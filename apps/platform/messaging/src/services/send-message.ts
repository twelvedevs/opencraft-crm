import { Type, type Static } from '@sinclair/typebox';
import { Value } from '@sinclair/typebox/value';
import type { OptOutRegistry } from './opt-out-registry.js';
import type { MessagesRepository } from '../repositories/messages.repo.js';
import type { NumberResolver, NumberNotFoundError } from './number-resolver.js';
import type { RateLimiter } from './rate-limiter.js';
import type { TwilioClient } from './twilio-client.js';
import { renderTemplate } from './template-renderer.js';

const SendMessageParamsSchema = Type.Object({
  to: Type.String(),
  from_number: Type.Optional(Type.String()),
  location_id: Type.Optional(Type.String()),
  channel: Type.Optional(Type.String()),
  template: Type.Optional(Type.String()),
  context: Type.Optional(Type.Record(Type.String(), Type.String())),
  body: Type.Optional(Type.String()),
  media_url: Type.Optional(Type.String()),
  dedup_key: Type.Optional(Type.String()),
});

export type SendMessageParams = Static<typeof SendMessageParamsSchema>;

export type SendMessageResult =
  | { status: 'queued'; code: 200; message_id: string }
  | { status: 'duplicate'; code: 200; message_id: string }
  | { status: 'opted_out'; code: 400 }
  | { status: 'number_not_found'; code: 422; error: string }
  | { status: 'throttled'; code: 429; retryAfter: number }
  | { status: 'twilio_error'; code: 502; error: string }
  | { status: 'validation_error'; code: 400; error: string };

export class SendMessageService {
  constructor(
    private readonly optOutRegistry: OptOutRegistry,
    private readonly messagesRepo: MessagesRepository,
    private readonly numberResolver: NumberResolver,
    private readonly rateLimiter: RateLimiter,
    private readonly twilioClient: TwilioClient,
    private readonly statusCallbackUrl: string,
  ) {}

  async send(params: SendMessageParams): Promise<SendMessageResult> {
    // 1. Validate
    if (!Value.Check(SendMessageParamsSchema, params)) {
      const errors = [...Value.Errors(SendMessageParamsSchema, params)];
      const first = errors[0];
      return {
        status: 'validation_error',
        code: 400,
        error: first ? `${first.path}: ${first.message}` : 'Invalid request',
      };
    }

    // 2. Check opt-out
    const optedOut = await this.optOutRegistry.isOptedOut(params.to);
    if (optedOut) {
      return { status: 'opted_out', code: 400 };
    }

    // 3. Check dedup
    if (params.dedup_key) {
      const existing = await this.messagesRepo.findByDedupKey(params.dedup_key);
      if (existing) {
        return { status: 'duplicate', code: 200, message_id: existing.id };
      }
    }

    // 4. Resolve from_number
    let phoneNumber: string;
    let rateLimitMps: number;
    try {
      const resolved = await this.numberResolver.resolve({
        from_number: params.from_number,
        location_id: params.location_id,
        channel: params.channel,
      });
      phoneNumber = resolved.phone_number;
      rateLimitMps = resolved.rate_limit_mps;
    } catch (err: unknown) {
      if (err && typeof err === 'object' && 'name' in err && (err as { name: string }).name === 'NumberNotFoundError') {
        return {
          status: 'number_not_found',
          code: 422,
          error: (err as Error).message,
        };
      }
      throw err;
    }

    // 5. Render body
    let body: string;
    if (params.template && params.context) {
      body = renderTemplate(params.template, params.context);
    } else if (params.body) {
      body = params.body;
    } else {
      body = '';
    }

    // 6. Rate limit
    const rateResult = await this.rateLimiter.tryConsume(phoneNumber, rateLimitMps);
    if (!rateResult.allowed) {
      return {
        status: 'throttled',
        code: 429,
        retryAfter: rateResult.retryAfter ?? 1,
      };
    }

    // 7. Call Twilio
    let twilioSid: string;
    try {
      const result = await this.twilioClient.sendMessage({
        to: params.to,
        from: phoneNumber,
        body,
        mediaUrl: params.media_url,
        statusCallback: this.statusCallbackUrl,
      });
      twilioSid = result.sid;
    } catch (err: unknown) {
      // Insert failed message
      const failedMsg = await this.messagesRepo.create({
        direction: 'outbound',
        to_number: params.to,
        from_number: phoneNumber,
        body,
        media_urls: params.media_url ? [params.media_url] : null,
        message_type: 'normal',
        status: 'failed',
        dedup_key: params.dedup_key ?? null,
        error_code: 'TWILIO_SEND_ERROR',
        error_message: err instanceof Error ? err.message : String(err),
        sent_at: null,
        delivered_at: null,
        received_at: null,
        twilio_sid: null,
      });
      return {
        status: 'twilio_error',
        code: 502,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    // 8. Insert queued message
    const message = await this.messagesRepo.create({
      direction: 'outbound',
      to_number: params.to,
      from_number: phoneNumber,
      body,
      media_urls: params.media_url ? [params.media_url] : null,
      message_type: 'normal',
      status: 'queued',
      twilio_sid: twilioSid,
      dedup_key: params.dedup_key ?? null,
      error_code: null,
      error_message: null,
      sent_at: new Date().toISOString(),
      delivered_at: null,
      received_at: null,
    });

    // 9. Return success
    return { status: 'queued', code: 200, message_id: message.id };
  }
}
