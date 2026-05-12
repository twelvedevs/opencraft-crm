import React from 'react'
import type { CampaignSummary, Location } from '../types.js'

interface CampaignRowProps {
  campaign: CampaignSummary
  locationId: string | null
  locations: Location[]
  onChange: (campaignId: string, locationId: string | null) => void
}

export function CampaignRow({ campaign, locationId, locations, onChange }: CampaignRowProps) {
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: '1fr 24px 1fr',
      gap: 8,
      alignItems: 'center',
      marginBottom: 6,
    }}>
      <div style={{
        background: '#f5f5f5',
        padding: '5px 8px',
        borderRadius: 3,
        fontSize: 12,
      }}>
        {campaign.campaign_name}
      </div>
      <div style={{ color: '#bbb', textAlign: 'center', fontSize: 14 }}>→</div>
      <select
        className="ih-select"
        value={locationId ?? ''}
        onChange={e => onChange(campaign.campaign_id, e.target.value || null)}
        style={{
          padding: '5px 6px',
          borderRadius: 3,
          border: '1px solid #ddd',
          fontSize: 12,
          background: '#fff',
          width: '100%',
        }}
      >
        <option value="">— unassigned —</option>
        {locations.map(loc => (
          <option key={loc.id} value={loc.id}>{loc.name}</option>
        ))}
      </select>
    </div>
  )
}
