import React from 'react'
import type { IntegrationAccount } from '../types.js'
import type { IntegrationHubApiClient } from '../api/IntegrationHubApiClient.js'
import { StatusBadge } from './StatusBadge.js'

const PLATFORMS: Array<{ id: 'google_ads' | 'facebook_ads'; label: string }> = [
  { id: 'google_ads', label: 'Google Ads' },
  { id: 'facebook_ads', label: 'Meta' },
]

interface AccountSidebarProps {
  accounts: IntegrationAccount[]
  selectedId: string | null
  client: IntegrationHubApiClient
  connectReturnUrl: string
  onSelect: (id: string) => void
}

export function AccountSidebar({
  accounts,
  selectedId,
  client,
  connectReturnUrl,
  onSelect,
}: AccountSidebarProps) {
  const connectedPlatforms = new Set(accounts.map(a => a.platform))
  const unconnectedPlatforms = PLATFORMS.filter(p => !connectedPlatforms.has(p.id))

  return (
    <div style={{ width: 200, borderRight: '1px solid #ddd', display: 'flex', flexDirection: 'column' }}>
      {accounts.length > 0 && (
        <div style={{ padding: '10px 12px', borderBottom: '1px solid #eee' }}>
          <div style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            color: '#888',
            letterSpacing: '.5px',
            marginBottom: 8,
          }}>
            Connected Accounts
          </div>
          {accounts.map(account => {
            const selected = account.id === selectedId
            return (
              <div
                key={account.id}
                className={`ih-account-item${selected ? ' selected' : ''}`}
                onClick={() => onSelect(account.id)}
                style={{
                  padding: '8px 10px',
                  marginBottom: 4,
                  borderRadius: 4,
                  borderLeft: `3px solid ${selected ? '#1976d2' : 'transparent'}`,
                  background: selected ? '#e3f2fd' : 'transparent',
                  cursor: 'pointer',
                }}
              >
                <div style={{ fontWeight: 600, marginBottom: 4, fontSize: 13 }}>
                  {account.platform === 'google_ads' ? 'Google Ads' : 'Meta'}
                </div>
                <StatusBadge status={account.status} />
                {account.last_polled_at && (
                  <div style={{ color: '#888', fontSize: 10, marginTop: 2 }}>
                    polled {new Date(account.last_polled_at).toLocaleDateString()}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {unconnectedPlatforms.length > 0 && (
        <div style={{ padding: '10px 12px' }}>
          <div style={{
            fontSize: 10,
            fontWeight: 600,
            textTransform: 'uppercase',
            color: '#888',
            letterSpacing: '.5px',
            marginBottom: 8,
          }}>
            Add Integration
          </div>
          {unconnectedPlatforms.map(p => (
            <a
              key={p.id}
              href={client.getConnectUrl(p.id, connectReturnUrl)}
              className="ih-connect-btn"
              style={{
                display: 'block',
                padding: '6px 8px',
                marginBottom: 4,
                borderRadius: 3,
                border: '1px solid #ddd',
                fontSize: 12,
                color: '#1976d2',
                textDecoration: 'none',
                cursor: 'pointer',
              }}
            >
              + Connect {p.label}
            </a>
          ))}
        </div>
      )}
    </div>
  )
}
