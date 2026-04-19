import React from 'react'
import type { ActiveHours } from '../types.js'
import { label, inputStyle } from './utils.js'

interface Props {
  activeHours: ActiveHours | null
  onChange: (v: ActiveHours | null) => void
}

const DEFAULT: ActiveHours = { start: '08:00', end: '20:00', timezone_field: 'context.location_timezone' }

export function ActiveHoursConfig({ activeHours, onChange }: Props) {
  const enabled = activeHours !== null
  const value = activeHours ?? DEFAULT

  return (
    <div style={{ borderTop: '1px solid #dee2e6', paddingTop: 12, marginTop: 12 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 10 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onChange(e.target.checked ? DEFAULT : null)} />
        <strong style={{ fontSize: 13 }}>Restrict to active hours</strong>
      </label>
      {enabled && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 100 }}>
            <span style={label}>Start (HH:MM)</span>
            <input style={inputStyle} type="time" value={value.start} onChange={(e) => onChange({ ...value, start: e.target.value })} />
          </div>
          <div style={{ flex: 1, minWidth: 100 }}>
            <span style={label}>End (HH:MM)</span>
            <input style={inputStyle} type="time" value={value.end} onChange={(e) => onChange({ ...value, end: e.target.value })} />
          </div>
          <div style={{ flex: 2, minWidth: 160 }}>
            <span style={label}>Timezone field (context path)</span>
            <input style={inputStyle} value={value.timezone_field} onChange={(e) => onChange({ ...value, timezone_field: e.target.value })} placeholder="context.location_timezone" />
          </div>
        </div>
      )}
    </div>
  )
}
