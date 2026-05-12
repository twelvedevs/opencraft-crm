export interface Location {
  id: string
  name: string
}

export interface IntegrationAccount {
  id: string
  platform: 'google_ads' | 'facebook_ads'
  account_id: string
  account_name: string | null
  status: 'active' | 'paused' | 'error'
  last_error: string | null
  last_polled_at: string | null
}

export interface CampaignSummary {
  campaign_id: string
  campaign_name: string
  location_id: string | null
}

export interface BackfillJob {
  job_id: string
  status: 'active' | 'completed' | 'failed'
  from_date: string
  to_date: string
  progress: {
    chunks_done: number
    chunks_total: number
  }
  error?: string
}
