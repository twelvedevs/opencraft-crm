import type { Knex } from '../db.js';
import type { EventBus } from '@ortho/event-bus';
import { EmailCampaignRecipientsRepository } from '../repositories/email-campaign-recipients-repository.js';
import { EmailCampaignJobsRepository } from '../repositories/email-campaign-jobs-repository.js';
import { EmailSendsRepository } from '../repositories/email-sends-repository.js';
import { EmailRecipientClicksRepository } from '../repositories/email-recipient-clicks-repository.js';
import { EmailSendClicksRepository } from '../repositories/email-send-clicks-repository.js';

export interface SendgridEvent {
  event: string;
  sg_message_id: string;
  email: string;
  timestamp: number;
  url?: string;
  type?: string;
  [key: string]: unknown;
}

export class WebhookProcessor {
  private readonly recipientsRepo: EmailCampaignRecipientsRepository;
  private readonly jobsRepo: EmailCampaignJobsRepository;
  private readonly sendsRepo: EmailSendsRepository;
  private readonly recipientClicksRepo: EmailRecipientClicksRepository;
  private readonly sendClicksRepo: EmailSendClicksRepository;

  constructor(
    db: Knex,
    private readonly eventBus: EventBus,
  ) {
    this.recipientsRepo = new EmailCampaignRecipientsRepository(db);
    this.jobsRepo = new EmailCampaignJobsRepository(db);
    this.sendsRepo = new EmailSendsRepository(db);
    this.recipientClicksRepo = new EmailRecipientClicksRepository(db);
    this.sendClicksRepo = new EmailSendClicksRepository(db);
  }

  async processEvent(event: SendgridEvent): Promise<void> {
    const ts = new Date(event.timestamp * 1000);

    const recipient = await this.recipientsRepo.findBySendgridMessageId(event.sg_message_id);

    if (recipient !== null) {
      const job = await this.jobsRepo.findById(recipient.job_id);

      switch (event.event) {
        case 'delivered':
          await this.recipientsRepo.markDelivered(recipient.id, ts);
          await this.eventBus.publish({
            event_type: 'email.delivered',
            entity_type: job?.entity_type ?? undefined,
            entity_id: job?.entity_id ?? undefined,
            payload: {
              email_id: recipient.id,
              to_email: recipient.to_email,
              location_id: job?.location_id,
              campaign_job_id: recipient.job_id,
            },
          });
          break;

        case 'open':
          await this.recipientsRepo.markOpenedFromWebhook(recipient.id, ts);
          await this.eventBus.publish({
            event_type: 'email.opened',
            entity_type: job?.entity_type ?? undefined,
            entity_id: job?.entity_id ?? undefined,
            payload: {
              email_id: recipient.id,
              to_email: recipient.to_email,
              location_id: job?.location_id,
              campaign_job_id: recipient.job_id,
            },
          });
          break;

        case 'click':
          await this.recipientsRepo.markClickedFromWebhook(recipient.id, ts);
          await this.recipientClicksRepo.insert(recipient.id, event.url!);
          await this.eventBus.publish({
            event_type: 'email.clicked',
            entity_type: job?.entity_type ?? undefined,
            entity_id: job?.entity_id ?? undefined,
            payload: {
              email_id: recipient.id,
              to_email: recipient.to_email,
              location_id: job?.location_id,
              campaign_job_id: recipient.job_id,
              url: event.url,
            },
          });
          break;

        case 'bounce':
          if (event.type === 'bounce') {
            await this.recipientsRepo.markBouncedFromWebhook(recipient.id, ts);
            await this.eventBus.publish({
              event_type: 'email.bounced',
              entity_type: job?.entity_type ?? undefined,
              entity_id: job?.entity_id ?? undefined,
              payload: {
                email_id: recipient.id,
                to_address: recipient.to_email,
                location_id: job?.location_id,
                bounce_type: 'hard',
                campaign_job_id: recipient.job_id,
              },
            });
          }
          // type === 'blocked' → no-op
          break;

        case 'deferred':
          // no-op
          break;

        case 'spamreport':
          await this.recipientsRepo.markSpamReported(recipient.id);
          await this.eventBus.publish({
            event_type: 'email.spam_reported',
            payload: {
              to_email: recipient.to_email,
              location_id: job?.location_id,
            },
          });
          break;

        case 'unsubscribe':
        case 'group_unsubscribe':
          await this.recipientsRepo.markUnsubscribed(recipient.id);
          await this.eventBus.publish({
            event_type: 'email.unsubscribed',
            payload: {
              to_email: recipient.to_email,
              location_id: job?.location_id,
            },
          });
          break;
      }
      return;
    }

    const send = await this.sendsRepo.findBySendgridMessageId(event.sg_message_id);

    if (send === null) {
      console.warn(
        `[WebhookProcessor] No recipient or send found for sg_message_id: ${event.sg_message_id}`,
      );
      return;
    }

    switch (event.event) {
      case 'delivered':
        await this.sendsRepo.markDelivered(send.id, ts);
        await this.eventBus.publish({
          event_type: 'email.delivered',
          entity_type: send.entity_type ?? undefined,
          entity_id: send.entity_id ?? undefined,
          payload: {
            email_id: send.id,
            to_email: send.to_email,
            location_id: send.location_id,
          },
        });
        break;

      case 'open':
        await this.sendsRepo.markOpened(send.id, ts);
        await this.eventBus.publish({
          event_type: 'email.opened',
          entity_type: send.entity_type ?? undefined,
          entity_id: send.entity_id ?? undefined,
          payload: {
            email_id: send.id,
            to_email: send.to_email,
            location_id: send.location_id,
          },
        });
        break;

      case 'click':
        await this.sendsRepo.markClicked(send.id, ts);
        await this.sendClicksRepo.insert(send.id, event.url!);
        await this.eventBus.publish({
          event_type: 'email.clicked',
          entity_type: send.entity_type ?? undefined,
          entity_id: send.entity_id ?? undefined,
          payload: {
            email_id: send.id,
            to_email: send.to_email,
            location_id: send.location_id,
            url: event.url,
          },
        });
        break;

      case 'bounce':
        if (event.type === 'bounce') {
          await this.sendsRepo.markBouncedFromWebhook(send.id, ts);
          await this.eventBus.publish({
            event_type: 'email.bounced',
            entity_type: send.entity_type ?? undefined,
            entity_id: send.entity_id ?? undefined,
            payload: {
              email_id: send.id,
              to_address: send.to_email,
              location_id: send.location_id,
              bounce_type: 'hard',
            },
          });
        }
        // type === 'blocked' → no-op
        break;

      case 'deferred':
        // no-op
        break;

      case 'spamreport':
        await this.sendsRepo.markSpamReported(send.id);
        await this.eventBus.publish({
          event_type: 'email.spam_reported',
          entity_type: send.entity_type ?? undefined,
          entity_id: send.entity_id ?? undefined,
          payload: {
            to_email: send.to_email,
            location_id: send.location_id,
          },
        });
        break;

      case 'unsubscribe':
      case 'group_unsubscribe':
        await this.sendsRepo.markUnsubscribed(send.id);
        await this.eventBus.publish({
          event_type: 'email.unsubscribed',
          entity_type: send.entity_type ?? undefined,
          entity_id: send.entity_id ?? undefined,
          payload: {
            to_email: send.to_email,
            location_id: send.location_id,
          },
        });
        break;
    }
  }

  async processBatch(events: SendgridEvent[]): Promise<void> {
    for (const event of events) {
      try {
        await this.processEvent(event);
      } catch (err) {
        console.error('[WebhookProcessor] Error processing event', { event, err });
      }
    }
  }
}
