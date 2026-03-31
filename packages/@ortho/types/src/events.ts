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
