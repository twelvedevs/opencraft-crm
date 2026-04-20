import React, { useState } from 'react'
import type { IntegrationAccount, CampaignSummary, BackfillJob, Location } from '../types.js'
import { StatusBadge } from './StatusBadge.js'
import { CampaignRow } from './CampaignRow.js'

interface AccountDetailProps {
  account: IntegrationAccount
  campaigns: CampaignSummary[]
  mappings: Record<string, string>
  locations: Location[]
  saving: boolean
  latestJob: BackfillJob | null
  triggering: boolean
  onSetMapping: (campaignId: string, locationId: string | null) => void
  onSave: () => void
  onDisconnect: (id: string) => void
  onTriggerBackfill: (from: string, to: string) => Promise<void>
}

export function AccountDetail({
  account,
  campaigns,
  mappings,
  locations,
  saving,
  latestJob,
  triggering,
  onSetMapping,
  onSave,
  onDisconnect,
  onTriggerBackfill,
}: AccountDetailProps) {
  const [backfillFrom, setBackfillFrom] = useState('')
  const [backfillTo, setBackfillTo] = useState('')
  const [backfillError, setBackfillError] = useState<string | null>(null)

  const platformLabel = account.platform === 'google_ads' ? 'Google Ads' : 'Meta'

  async function handleTrigger() {
    setBackfillError(null)
    try {
      await onTriggerBackfill(backfillFrom, backfillTo)
    } catch (err) {
      setBackfillError(err instanceof Error ? err.message : 'Backfill failed')
    }
  }

  return (
    <div className="ih-detail-panel" style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
      {/* Account header */}
      <div style={{
        padding: '10px 16px',
        borderBottom: '1px solid #eee',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div>
          <span style={{ fontWeight: 600, marginRight: 8 }}>{platformLabel}</span>
          <StatusBadge status={account.status} />
          <div style={{ color: '#888', fontSize: 11, marginTop: 2 }}>
            Account #{account.account_id}
            {account.last_polled_at && ` · last polled ${new Date(account.last_polled_at).toLocaleString()}`}
          </div>
          {account.last_error && (
            <div style={{ color: '#c62828', fontSize: 11, marginTop: 2 }}>{account.last_error}</div>
          )}
        </div>
        <button
          onClick={() => onDisconnect(account.id)}
          style={{
            padding: '4px 12px',
            fontSize: 12,
            background: '#ffebee',
            color: '#c62828',
            border: '1px solid #ef9a9a',
            borderRadius: 3,
            cursor: 'pointer',
          }}
        >
          Disconnect
        </button>
      </div>

      {/* Campaign mapper + backfill */}
      <div style={{ padding: '14px 16px', flex: 1, overflowY: 'auto' }}>
        <div style={{ fontWeight: 600, marginBottom: 4 }}>Campaign → Location Mapping</div>
        <div style={{ color: '#666', fontSize: 12, marginBottom: 12 }}>
          Campaigns with no location assigned are tracked but spend data is not published.
        </div>

        {campaigns.length === 0 ? (
          <div style={{ color: '#999', fontSize: 12, fontStyle: 'italic' }}>No campaigns found.</div>
        ) : (
          <>
            <div style={{
              display: 'grid',
              gridTemplateColumns: '1fr 24px 1fr',
              gap: 8,
              marginBottom: 4,
              fontSize: 10,
              fontWeight: 600,
              color: '#888',
              textTransform: 'uppercase',
              letterSpacing: '.4px',
            }}>
              <div>Campaign</div>
              <div />
              <div>Location</div>
            </div>
            {campaigns.map(c => (
              <CampaignRow
                key={c.campaign_id}
                campaign={c}
                locationId={mappings[c.campaign_id] ?? null}
                locations={locations}
                onChange={onSetMapping}
              />
            ))}
            <button
              onClick={onSave}
              disabled={saving}
              style={{
                marginTop: 8,
                padding: '5px 16px',
                fontSize: 12,
                background: '#1976d2',
                color: '#fff',
                border: '1px solid #1976d2',
                borderRadius: 3,
                cursor: saving ? 'not-allowed' : 'pointer',
                opacity: saving ? .7 : 1,
              }}
            >
              {saving ? 'Saving…' : 'Save Mappings'}
            </button>
          </>
        )}

        {/* Backfill */}
        <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid #eee' }}>
          <div style={{ fontWeight: 600, marginBottom: 4 }}>Ad Spend Backfill</div>
          <div style={{ color: '#666', fontSize: 12, marginBottom: 12 }}>
            Import historical spend data. Publishes <code>ad_spend.synced</code> events to Analytics Service.
          </div>

          <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 3 }}>From</div>
              <input
                type="date"
                value={backfillFrom}
                onChange={e => setBackfillFrom(e.target.value)}
                style={{ padding: '5px 6px', border: '1px solid #ddd', borderRadius: 3, fontSize: 12 }}
              />
            </div>
            <div>
              <div style={{ fontSize: 11, color: '#666', marginBottom: 3 }}>To</div>
              <input
                type="date"
                value={backfillTo}
                onChange={e => setBackfillTo(e.target.value)}
                style={{ padding: '5px 6px', border: '1px solid #ddd', borderRadius: 3, fontSize: 12 }}
              />
            </div>
            <button
              onClick={() => void handleTrigger()}
              disabled={triggering || !backfillFrom || !backfillTo}
              style={{
                padding: '5px 14px',
                fontSize: 12,
                background: '#fff',
                border: '1px solid #ddd',
                borderRadius: 3,
                cursor: triggering ? 'not-allowed' : 'pointer',
                opacity: triggering ? .7 : 1,
              }}
            >
              {triggering ? 'Starting…' : 'Run Backfill'}
            </button>
          </div>

          {backfillError && (
            <div style={{ color: '#c62828', fontSize: 12, marginTop: 6 }}>{backfillError}</div>
          )}

          {latestJob && (
            <div style={{ marginTop: 10, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
              <span style={{ color: '#666' }}>Last job:</span>
              <StatusBadge status={latestJob.status} />
              <span style={{ color: '#888' }}>
                {latestJob.from_date} – {latestJob.to_date} · {latestJob.progress.chunks_done}/{latestJob.progress.chunks_total} chunks
              </span>
            </div>
          )}
          {latestJob && (
            <div style={{ color: '#aaa', fontSize: 11, marginTop: 3 }}>Refresh page to update status.</div>
          )}
        </div>
      </div>
    </div>
  )
}
