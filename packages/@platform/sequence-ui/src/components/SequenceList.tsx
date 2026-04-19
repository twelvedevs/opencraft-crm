import React, { useState } from 'react'
import { SequenceApiClient } from '../api/SequenceApiClient.js'
import { useSequenceList } from '../hooks/useSequenceList.js'
import type { SequenceListProps } from '../types.js'
import { btn, primaryBtn, StatusBadge } from './utils.js'

const th: React.CSSProperties = { textAlign: 'left', padding: '8px', fontWeight: 600, fontSize: 13 }
const td: React.CSSProperties = { padding: '8px', fontSize: 13 }

export function SequenceList({ nurturingEngineUrl, token, userRole, onEdit }: SequenceListProps) {
  const [client] = useState(() => new SequenceApiClient(nurturingEngineUrl, token))
  const { sequences, loading, error, activate, disable } = useSequenceList(client)
  const [actionError, setActionError] = useState<string | null>(null)

  const canManage = userRole === 'marketing_manager' || userRole === 'super_admin'

  const handleNew = async () => {
    try {
      const { sequence_id } = await client.createSequence('New Sequence')
      onEdit(sequence_id)
    } catch (e) {
      setActionError(e instanceof Error ? e.message : 'Failed to create sequence')
    }
  }

  if (loading) return <div style={{ padding: 16 }}>Loading sequences...</div>
  if (error) return <div style={{ padding: 16, color: '#721c24' }}>{error}</div>

  return (
    <div style={{ padding: 16 }}>
      {actionError && <div style={{ color: '#721c24', marginBottom: 8 }}>{actionError}</div>}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <h2 style={{ margin: 0 }}>Sequences</h2>
        <button style={primaryBtn} onClick={() => void handleNew()}>New Sequence</button>
      </div>
      {sequences.length === 0 ? (
        <div style={{ textAlign: 'center', color: '#6c757d', padding: 32 }}>No sequences yet.</div>
      ) : (
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '2px solid #dee2e6' }}>
              <th style={th}>Name</th>
              <th style={th}>Status</th>
              <th style={th}>Steps</th>
              <th style={th}>A/B</th>
              <th style={th}>Version</th>
              <th style={th}>Actions</th>
            </tr>
          </thead>
          <tbody>
            {sequences.map((seq) => (
              <tr key={seq.sequence_id} style={{ borderBottom: '1px solid #dee2e6' }}>
                <td style={td}>{seq.name}</td>
                <td style={td}><StatusBadge status={seq.status} /></td>
                <td style={td}>{seq.step_count}</td>
                <td style={td}>{seq.has_ab_test ? 'A/B' : '—'}</td>
                <td style={td}>v{seq.current_version}</td>
                <td style={td}>
                  <button style={btn} onClick={() => onEdit(seq.sequence_id)}>Edit</button>
                  {canManage && seq.status === 'draft' && (
                    <button style={btn} onClick={() => void activate(seq.sequence_id)}>Activate</button>
                  )}
                  {canManage && seq.status === 'active' && (
                    <button style={btn} onClick={() => void disable(seq.sequence_id)}>Disable</button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}
