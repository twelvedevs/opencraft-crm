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
