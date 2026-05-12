import React from 'react'
import { useABStats } from '../hooks/useABStats.js'
import type { SequenceApiClient } from '../api/SequenceApiClient.js'

const card: React.CSSProperties = {
  flex: 1, minWidth: 200, background: '#f8f9fa', border: '1px solid #dee2e6',
  borderRadius: 8, padding: 20,
}

const metricLabel: React.CSSProperties = { fontSize: 12, color: '#6c757d', marginBottom: 2 }
const metricValue: React.CSSProperties = { fontSize: 22, fontWeight: 700, marginBottom: 8 }

interface Props {
  sequenceId: string
  client: SequenceApiClient
}

export function ABResults({ sequenceId, client }: Props) {
  const { stats, loading, error } = useABStats(client, sequenceId)

  if (loading) return <div style={{ padding: 20, color: '#6c757d', fontSize: 13 }}>Loading A/B results...</div>
  if (error) return <div style={{ padding: 20, color: '#721c24', fontSize: 13 }}>{error}</div>
  if (!stats?.ab) return <div style={{ padding: 20, color: '#6c757d', fontSize: 13 }}>No A/B data available.</div>

  const { A, B, winner, significant, p_value } = stats.ab

  return (
    <div style={{ padding: 20 }}>
      <div style={{ marginBottom: 16 }}>
        <h3 style={{ margin: '0 0 4px' }}>A/B Test Results</h3>
        {significant && winner && (
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '4px 12px', background: '#d4edda', color: '#155724', borderRadius: 20, fontSize: 13, fontWeight: 600 }}>
            Winner: Variant {winner}
            {p_value != null && <span style={{ fontWeight: 400 }}>(p={p_value.toFixed(3)})</span>}
          </div>
        )}
        {!significant && <div style={{ fontSize: 13, color: '#6c757d' }}>No statistically significant winner yet.</div>}
      </div>

      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
        {([['A', A], ['B', B]] as const).map(([variant, data]) => (
          <div key={variant} style={{ ...card, ...(winner === variant ? { borderColor: '#198754', boxShadow: '0 0 0 2px #19875433' } : {}) }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 12 }}>Variant {variant}</div>
            <div style={metricLabel}>Enrollments</div>
            <div style={metricValue}>{data.enrollments}</div>
            <div style={metricLabel}>Completion rate</div>
            <div style={metricValue}>{Math.round(data.completion_rate * 100)}%</div>
            <div style={metricLabel}>Conversion rate</div>
            <div style={{ ...metricValue, color: '#0f5132' }}>{Math.round(data.conversion_rate * 100)}%</div>
            <div style={{ fontSize: 12, color: '#6c757d' }}>{data.conversion_count} conversions</div>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 20, padding: 12, background: '#f0f4ff', borderRadius: 6 }}>
        <div style={{ fontSize: 12, color: '#6c757d' }}>Overall: {stats.total_enrollments} enrolled · {stats.completed_count} completed · {stats.failed_count} failed</div>
      </div>
    </div>
  )
}
