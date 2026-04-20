import React from 'react'
import type { IntegrationHubApiClient } from '../api/IntegrationHubApiClient.js'
import type { Location } from '../types.js'
import { useIntegrationAccounts } from '../hooks/useIntegrationAccounts.js'
import { useCampaignMapper } from '../hooks/useCampaignMapper.js'
import { useBackfillStatus } from '../hooks/useBackfillStatus.js'
import { AccountSidebar } from './AccountSidebar.js'
import { AccountDetail } from './AccountDetail.js'

export interface IntegrationHubProps {
  client: IntegrationHubApiClient
  locations: Location[]
  connectReturnUrl: string
}

export function IntegrationHub({ client, locations, connectReturnUrl }: IntegrationHubProps) {
  const { accounts, selectedId, loading, error, selectAccount, disconnect } =
    useIntegrationAccounts(client)

  const selectedAccount = accounts.find(a => a.id === selectedId) ?? null

  const { campaigns, mappings, saving, setMapping, save } =
    useCampaignMapper(client, selectedId)

  const { latestJob, triggering, triggerBackfill } =
    useBackfillStatus(client, selectedId)

  if (loading) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 200, color: '#888', fontSize: 13 }}>
        Loading…
      </div>
    )
  }

  if (error) {
    return (
      <div style={{ padding: 16, color: '#c62828', fontSize: 13 }}>
        Failed to load integrations: {error}
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', minHeight: 400, border: '1px solid #eee', borderRadius: 4, overflow: 'hidden' }}>
      <AccountSidebar
        accounts={accounts}
        selectedId={selectedId}
        client={client}
        connectReturnUrl={connectReturnUrl}
        onSelect={selectAccount}
      />

      <div style={{ flex: 1, display: 'flex', alignItems: 'stretch' }}>
        {!selectedAccount ? (
          <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#888', fontSize: 13, padding: 24, textAlign: 'center' }}>
            Connect your first ad account to get started.
          </div>
        ) : (
          <AccountDetail
            account={selectedAccount}
            campaigns={campaigns}
            mappings={mappings}
            locations={locations}
            saving={saving}
            latestJob={latestJob}
            triggering={triggering}
            onSetMapping={setMapping}
            onSave={() => void save()}
            onDisconnect={id => void disconnect(id)}
            onTriggerBackfill={triggerBackfill}
          />
        )}
      </div>
    </div>
  )
}
