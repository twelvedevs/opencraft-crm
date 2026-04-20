import React from 'react'
import type { SendEmailParams } from '../../types.js'
import { label, inputStyle } from '../utils.js'

interface Props {
  params: SendEmailParams
  onParamsChange: (p: SendEmailParams) => void
  onBrowseTemplate: () => void
}

export function SendEmailForm({ params, onParamsChange, onBrowseTemplate }: Props) {
  const set = (patch: Partial<SendEmailParams>) => onParamsChange({ ...params, ...patch })
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
        <input style={inputStyle} value={params.to_field} onChange={(e) => set({ to_field: e.target.value })} placeholder="context.email" />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>From field (context path)</span>
        <input style={inputStyle} value={params.from_field} onChange={(e) => set({ from_field: e.target.value })} placeholder="context.from_email" />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>Dedup key</span>
        <input style={inputStyle} value={params.dedup_key} onChange={(e) => set({ dedup_key: e.target.value })} placeholder="{{enrollment_id}}-step-1" />
      </div>
    </div>
  )
}
