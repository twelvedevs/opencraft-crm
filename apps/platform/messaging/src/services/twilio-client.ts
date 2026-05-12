import Twilio from 'twilio';

export interface TwilioSendParams {
  to: string;
  from: string;
  body: string;
  mediaUrl?: string;
  statusCallback?: string;
}

export interface TwilioClient {
  sendMessage(params: TwilioSendParams): Promise<{ sid: string }>;
}

export function createTwilioClient(
  accountSid: string,
  authToken: string,
): TwilioClient {
  const client = Twilio(accountSid, authToken);

  return {
    async sendMessage(params) {
      const message = await client.messages.create({
        to: params.to,
        from: params.from,
        body: params.body,
        mediaUrl: params.mediaUrl ? [params.mediaUrl] : undefined,
        statusCallback: params.statusCallback,
      });
      return { sid: message.sid };
    },
  };
}

export interface StubTwilioClient extends TwilioClient {
  calls: TwilioSendParams[];
  setError(err?: Error): void;
}

export function createStubTwilioClient(): StubTwilioClient {
  let nextError: Error | undefined;
  let sidCounter = 0;
  const calls: TwilioSendParams[] = [];

  return {
    calls,
    setError(err?: Error) {
      nextError = err;
    },
    async sendMessage(params) {
      calls.push(params);
      if (nextError) {
        const err = nextError;
        nextError = undefined;
        throw err;
      }
      sidCounter++;
      return { sid: `SM${String(sidCounter).padStart(32, '0')}` };
    },
  };
}
