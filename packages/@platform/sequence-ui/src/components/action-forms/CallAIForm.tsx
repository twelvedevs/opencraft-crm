import React from 'react'
import type { CallAIParams } from '../../types.js'
import { label, inputStyle } from '../utils.js'

const MODELS = ['claude-haiku-4-5-20251001', 'claude-sonnet-4-6']

interface Props {
  params: CallAIParams
  onParamsChange: (p: CallAIParams) => void
}

export function CallAIForm({ params, onParamsChange }: Props) {
  const set = (patch: Partial<CallAIParams>) => onParamsChange({ ...params, ...patch })
  return (
    <div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>System prompt</span>
        <textarea style={{ ...inputStyle, height: 72, resize: 'vertical' }} value={params.system_prompt} onChange={(e) => set({ system_prompt: e.target.value })} placeholder="You are a helpful orthodontic assistant." />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>User prompt</span>
        <textarea style={{ ...inputStyle, height: 72, resize: 'vertical' }} value={params.user_prompt} onChange={(e) => set({ user_prompt: e.target.value })} placeholder="Draft a follow-up SMS for {{context.first_name}}..." />
      </div>
      <div style={{ marginBottom: 10 }}>
        <span style={label}>Model</span>
        <select style={inputStyle} value={params.model} onChange={(e) => set({ model: e.target.value })}>
          {MODELS.map((m) => <option key={m} value={m}>{m}</option>)}
        </select>
      </div>
      <div style={{ marginBottom: 10 }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={params.auto_send} onChange={(e) => set({ auto_send: e.target.checked })} />
          Auto-send output as message (requires manager approval)
        </label>
      </div>
    </div>
  )
}
