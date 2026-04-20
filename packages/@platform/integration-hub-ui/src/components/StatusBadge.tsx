import React from 'react'

type StatusBadgeStatus = 'active' | 'paused' | 'error' | 'completed' | 'failed'

interface StatusBadgeProps {
  status: StatusBadgeStatus
}

const CONFIG: Record<StatusBadgeStatus, { bg: string; color: string }> = {
  active:    { bg: '#e8f5e9', color: '#2e7d32' },
  completed: { bg: '#e8f5e9', color: '#2e7d32' },
  paused:    { bg: '#fff3e0', color: '#e65100' },
  error:     { bg: '#ffebee', color: '#c62828' },
  failed:    { bg: '#ffebee', color: '#c62828' },
}

export function StatusBadge({ status }: StatusBadgeProps) {
  const { bg, color } = CONFIG[status] ?? CONFIG.error
  return (
    <span style={{
      background: bg,
      color,
      padding: '2px 8px',
      borderRadius: 10,
      fontSize: 11,
      fontWeight: 500,
    }}>
      {status}
    </span>
  )
}
