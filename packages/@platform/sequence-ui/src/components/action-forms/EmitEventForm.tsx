import React from 'react'
import type { EmitEventParams } from '../../types.js'
import { label, inputStyle, btn } from '../utils.js'

interface Props {
  params: EmitEventParams
  onParamsChange: (p: EmitEventParams) => void
}

export function EmitEventForm({ params, onParamsChange }: Props) {
  const set = (patch: Partial<EmitEventParams>) => onParamsChange({ ...params, ...patch })

  const setPayloadKey = (oldKey: string, newKey: string) => {
    const entries = Object.entries(params.payload)
    const updated = Object.fromEntries(entries.map(([k, v]) => [k === oldKey ? newKey : k, v]))
    set({ payload: updated })
  }

  const setPayloadValue = (key: string, val: string) => {
    set({ payload: { ...params.payload, [key]: val } })
  }

  const addPayloadEntry = () => set({ payload: { ...params.payload, '': '' } })

  const removePayloadEntry = (key: string) => {
    const next = { ...params.payload }
    delete next[key]
    set({ payload: next })
  }

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>Event type</span>
        <input style={inputStyle} value={params.event_type} onChange={(e) => set({ event_type: e.target.value })} placeholder="nurturing.no_response_escalation" />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>Payload fields</span>
        {Object.entries(params.payload).map(([key, val]) => (
          <div key={key} style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
            <input style={{ ...inputStyle, flex: 1 }} value={key} onChange={(e) => setPayloadKey(key, e.target.value)} placeholder="field" />
            <input style={{ ...inputStyle, flex: 1 }} value={val} onChange={(e) => setPayloadValue(key, e.target.value)} placeholder="context.entity_id" />
            <button type="button" style={{ ...btn, padding: '2px 8px', color: '#dc3545' }} onClick={() => removePayloadEntry(key)}>&#10005;</button>
          </div>
        ))}
        <button type="button" style={btn} onClick={addPayloadEntry}>+ Add field</button>
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={params.include_context} onChange={(e) => set({ include_context: e.target.checked })} />
          Include full enrollment context in payload
        </label>
      </div>
    </div>
  )
}
