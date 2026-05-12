import React from 'react'
import type { SendMessageParams } from '../../types.js'
import { label, inputStyle } from '../utils.js'

interface Props {
  params: SendMessageParams
  abOverride?: Record<string, unknown>
  onParamsChange: (p: SendMessageParams) => void
  onAbOverrideChange: (o: Record<string, unknown> | undefined) => void
  onBrowseTemplate: () => void
}

export function SendMessageForm({ params, abOverride, onParamsChange, onAbOverrideChange, onBrowseTemplate }: Props) {
  const set = (patch: Partial<SendMessageParams>) => onParamsChange({ ...params, ...patch })
  const hasABOverride = abOverride !== undefined

  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>Template ID</span>
        <div style={{ display: 'flex', gap: 6 }}>
          <input style={{ ...inputStyle, flex: 1 }} value={params.template_id} onChange={(e) => set({ template_id: e.target.value })} placeholder="template-id" />
          <button type="button" onClick={onBrowseTemplate} style={{ padding: '4px 10px', border: '1px solid #ccc', borderRadius: 4, cursor: 'pointer', fontSize: 13, whiteSpace: 'nowrap' }}>Browse</button>
        </div>
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>To field (context path)</span>
        <input style={inputStyle} value={params.to_field} onChange={(e) => set({ to_field: e.target.value })} placeholder="context.phone" />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>From field (context path)</span>
        <input style={inputStyle} value={params.from_field} onChange={(e) => set({ from_field: e.target.value })} placeholder="context.location_number" />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>Dedup key</span>
        <input style={inputStyle} value={params.dedup_key} onChange={(e) => set({ dedup_key: e.target.value })} placeholder="{{enrollment_id}}-step-1" />
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={hasABOverride} onChange={(e) => onAbOverrideChange(e.target.checked ? {} : undefined)} />
          A/B variant B template override
        </label>
        {hasABOverride && (
          <div style={{ marginTop: 8, padding: 10, background: '#f8f9fa', borderRadius: 4 }}>
            <span style={label}>Variant B — Template ID</span>
            <input
              style={inputStyle}
              value={String((abOverride as Record<string, string>).template_id ?? '')}
              onChange={(e) => onAbOverrideChange({ ...abOverride, template_id: e.target.value })}
              placeholder="template-id-variant-b"
            />
          </div>
        )}
      </div>
    </div>
  )
}
