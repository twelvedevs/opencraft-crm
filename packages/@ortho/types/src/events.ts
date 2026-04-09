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
  membership_id: string;
  lead_id: string;
  location_id: string;
  pipeline: string;
  archived_at: string;
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
  membership_id: string;
  lead_id: string;
  location_id: string;
  pipeline: string;
  stage_to: string;
  stage_from: string | null;
  override: boolean;
  triggered_by: string | null;
  reason: string;
  timeout_at: string | null;
  transitioned_at: string;
  time_in_stage_seconds: number | null;
  response_time_seconds?: number | null;
}

export interface LeadConvertedPayload {
  lead_id: string;
  location_id: string;
  from_pipeline: string;
  from_stage: string;
  to_pipeline: string;
  to_stage: string;
  new_membership_id: string;
  channel: string;
  triggered_by: string | null;
  converted_at: string;
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
  referral_id: string;
  lead_id: string;
  location_id: string;
  referrer_id: string;
  referrer_type: string;
  converted_at: string;
}

export interface ReferrerCreatedPayload {
  referrer_id: string;
  referrer_type: string;
  lead_id: string;
  location_id: string;
  referral_link_id: string;
  referral_code: string;
  referral_link_url: string;
  created_at: string;
}

export interface ReferrerCreatedEvent {
  event_type: 'referrer.created';
  entity_type: 'referrer';
  entity_id: string;
  payload: ReferrerCreatedPayload;
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

// --- Conversation Service published events ---

export interface MessageReceivedPayload {
  entity_type: 'lead';
  entity_id: string;
  message_id: string;
  conversation_id: string;
  lead_id: string;
  location_id: string;
  body: string;
  message_type: 'normal' | 'stop' | 'unstop';
  from_number: string;
  practice_number: string;
  received_at: string;
}

export interface MessageReceivedEvent {
  event_type: 'message.received';
  entity_type: 'lead';
  entity_id: string;
  payload: MessageReceivedPayload;
}

// --- Campaign Service published events ---

export interface CampaignSentPayload {
  campaign_id: string;
  location_id: string;
  sent_count: number;
  template_id: string;
  completed_at: string;
}

export interface CampaignSentEvent {
  event_type: 'campaign.sent';
  occurred_at: string;
  payload: CampaignSentPayload;
}

export interface EmailCampaignCompletedPayload {
  job_id: string;
  status: 'completed' | 'completed_with_errors' | 'failed' | 'cancelled';
  sent_count: number;
  failed_count: number;
  total_recipients: number;
  location_id: string;
  completed_at: string;
}

export interface EmailOpenedPayload {
  campaign_job_id: string;
  entity_type: string;
  entity_id: string;
}
