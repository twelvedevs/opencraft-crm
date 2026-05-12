import React from 'react'
import { useEnrollments } from '../hooks/useEnrollments.js'
import type { SequenceApiClient } from '../api/SequenceApiClient.js'

const th: React.CSSProperties = { textAlign: 'left', padding: '8px 10px', fontWeight: 600, fontSize: 12, borderBottom: '2px solid #dee2e6' }
const td: React.CSSProperties = { padding: '8px 10px', fontSize: 13, borderBottom: '1px solid #f0f0f0' }

const variantColors: Record<string, { bg: string; color: string }> = {
  A: { bg: '#cfe2ff', color: '#084298' },
  B: { bg: '#d1e7dd', color: '#0f5132' },
}

interface Props {
  sequenceId: string
  client: SequenceApiClient
}

export function EnrollmentLog({ sequenceId, client }: Props) {
  const { enrollments, loading, error } = useEnrollments(client, sequenceId)

  if (loading) return <div style={{ padding: 20, color: '#6c757d', fontSize: 13 }}>Loading enrollments...</div>
  if (error) return <div style={{ padding: 20, color: '#721c24', fontSize: 13 }}>{error}</div>
  if (enrollments.length === 0) return <div style={{ padding: 20, color: '#6c757d', fontSize: 13 }}>No enrollments yet.</div>

  return (
    <div style={{ overflowX: 'auto', padding: 16 }}>
      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
        <thead>
          <tr>
            <th style={th}>ID</th>
            <th style={th}>Entity</th>
            <th style={th}>Variant</th>
            <th style={th}>Status</th>
            <th style={th}>Enrolled</th>
            <th style={th}>Completed</th>
          </tr>
        </thead>
        <tbody>
          {enrollments.map((e) => {
            const vc = e.ab_variant ? variantColors[e.ab_variant] : null
            return (
              <tr key={e.enrollment_id}>
                <td style={td}>{e.enrollment_id}</td>
                <td style={td}>{e.entity_type}/{e.entity_id}</td>
                <td style={td}>
                  {vc && e.ab_variant ? (
                    <span style={{ display: 'inline-block', padding: '1px 8px', borderRadius: 3, fontSize: 12, fontWeight: 700, background: vc.bg, color: vc.color }}>
                      {e.ab_variant}
                    </span>
                  ) : '—'}
                </td>
                <td style={td}>{e.status}</td>
                <td style={td}>{new Date(e.enrolled_at).toLocaleString()}</td>
                <td style={td}>{e.completed_at ? new Date(e.completed_at).toLocaleString() : '—'}</td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
