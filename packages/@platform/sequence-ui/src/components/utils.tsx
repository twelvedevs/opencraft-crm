import React from 'react'
import type { SequenceStatus } from '../types.js'

export const btn: React.CSSProperties = {
  padding: '4px 12px', border: '1px solid #ccc', borderRadius: 4,
  background: '#fff', cursor: 'pointer', fontSize: 13, marginRight: 4,
}

export const primaryBtn: React.CSSProperties = {
  ...btn, background: '#0066cc', color: '#fff', border: '1px solid #0066cc',
}

export const dangerBtn: React.CSSProperties = {
  ...btn, background: '#dc3545', color: '#fff', border: '1px solid #dc3545',
}

export const inputStyle: React.CSSProperties = {
  padding: '4px 8px', border: '1px solid #ccc', borderRadius: 4, fontSize: 13, width: '100%',
}

export const selectStyle: React.CSSProperties = { ...inputStyle }

export const label: React.CSSProperties = {
  fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 0.5,
  color: '#6c757d', display: 'block', marginBottom: 4,
}

const statusColors: Record<SequenceStatus, { bg: string; color: string }> = {
  active: { bg: '#d4edda', color: '#155724' },
  draft: { bg: '#fff3cd', color: '#856404' },
  disabled: { bg: '#f8d7da', color: '#721c24' },
}

export function StatusBadge({ status }: { status: SequenceStatus }) {
  const { bg, color } = statusColors[status]
  return (
    <span style={{ display: 'inline-block', padding: '2px 8px', borderRadius: 4, fontSize: 12, fontWeight: 600, background: bg, color }}>
      {status}
    </span>
  )
}
