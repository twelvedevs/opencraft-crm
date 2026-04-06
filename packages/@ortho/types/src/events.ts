export interface LeadOutboundSentPayload {
  phone: string;
  email: string;
  stage: string;
  is_first_in_stage: boolean;
  stage_entered_at: string;
  location_timezone: string;
  location_number: string;
  location_id: string;
  sent_at: string;
}

export interface LeadOutboundSentEvent {
  event_type: 'lead.outbound_sent';
  entity_type: 'lead';
  entity_id: string;
  payload: LeadOutboundSentPayload;
}

export interface LeadActivityLoggedPayload {
  activity_type: string;
  stage: string;
  logged_by: string;
  logged_at: string;
}

export interface LeadActivityLoggedEvent {
  event_type: 'lead.activity_logged';
  entity_type: 'lead';
  entity_id: string;
  payload: LeadActivityLoggedPayload;
}

// ad_lead.received
export interface AdLeadReceivedPayload {
  platform: string;
  external_lead_id: string;
  campaign_id: string;
  ad_set_id?: string;
  ad_id?: string;
  form_id?: string;
  location_id: string | null;
  fields: Record<string, string>;
}

export interface AdLeadReceivedEvent {
  event_type: 'ad_lead.received';
  payload: AdLeadReceivedPayload;
}

// ad_spend.synced
export interface AdSpendRecord {
  campaign_id: string;
  campaign_name: string;
  spend: number;
  impressions: number;
  clicks: number;
}

export interface AdSpendSyncedPayload {
  platform: string;
  location_id: string;
  synced_date: string;
  records: AdSpendRecord[];
}

export interface AdSpendSyncedEvent {
  event_type: 'ad_spend.synced';
  payload: AdSpendSyncedPayload;
}

// --- Lead Service published events ---

export interface LeadCreatedPayload {
  lead_id: string;
  location_id: string;
  channel: string;
  current_pipeline: string;
  current_stage: string | null;
  referrer_id?: string;
  referrer_type?: string;
  referral_code?: string;
}

export interface LeadCreatedEvent {
  event_type: 'lead.created';
  entity_type: 'lead';
  entity_id: string;
  payload: LeadCreatedPayload;
}

export interface LeadUpdatedPayload {
  lead_id: string;
  location_id: string;
  changed_fields: string[];
}

export interface LeadUpdatedEvent {
  event_type: 'lead.updated';
  entity_type: 'lead';
  entity_id: string;
  payload: LeadUpdatedPayload;
}

export interface LeadMergedPayload {
  surviving_lead_id: string;
  merged_lead_id: string;
  location_id: string;
}

export interface LeadMergedEvent {
  event_type: 'lead.merged';
  entity_type: 'lead';
  entity_id: string;
  payload: LeadMergedPayload;
}

export interface LeadArchivedPayload {
  lead_id: string;
  location_id: string;
}

export interface LeadArchivedEvent {
  event_type: 'lead.archived';
  entity_type: 'lead';
  entity_id: string;
  payload: LeadArchivedPayload;
}

// --- Lead Service subscribed events ---

export interface AppointmentUpdatedPayload {
  lead_id: string;
  appointment_id: string;
  appointment_type: string;
  scheduled_at: string;
  status: string;
  location_id: string;
}

export interface AppointmentUpdatedEvent {
  event_type: 'appointment.updated';
  entity_type: 'appointment';
  entity_id: string;
  payload: AppointmentUpdatedPayload;
}

export interface LeadStageChangedPayload {
  lead_id: string;
  location_id: string;
  pipeline: string;
  stage_to: string;
  stage_from: string;
  reason: string;
  time_in_stage_seconds: number;
  response_time_seconds?: number;
}

export interface LeadConvertedPayload {
  lead_id: string;
  location_id: string;
  channel: string;
}

export interface OptOutReceivedPayload {
  phone_number: string;
  opted_out_at: string;
  source: string;
}

export interface OptOutRemovedPayload {
  phone_number: string;
  removed_at: string;
}

export interface EmailBouncedPayload {
  to_address: string;
  bounce_type: 'hard' | 'soft';
}

export interface MessageDeliveredPayload {
  message_id: string;
  twilio_sid: string | null;
  to_number: string;
  from_number: string;
  delivered_at: string;
}

export interface MessageFailedPayload {
  message_id: string;
  twilio_sid: string | null;
  to_number: string;
  from_number: string;
  error_code: string | null;
  error_message: string | null;
}

export interface InboundMessageReceivedPayload {
  message_id: string;
  from_number: string;
  to_number: string;
  body: string | null;
  media_urls: string[] | null;
  received_at: string;
  message_type: string;
}

export interface ReferralConvertedPayload {
  lead_id: string;
  location_id: string;
  referrer_id: string;
  referrer_type: string;
}

export interface SequenceStepCompletedPayload {
  entity_id: string;
  entity_type: string;
  sequence_id: string;
  step_id: string;
}

export interface WorkflowTriggeredPayload {
  entity_id: string;
  entity_type: string;
  workflow_id: string;
}
