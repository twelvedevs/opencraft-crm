import React from 'react'
import type { ABTest } from '../types.js'
import { label, inputStyle } from './utils.js'

interface Props {
  abTest: ABTest | null
  onChange: (v: ABTest | null) => void
}

const DEFAULT: ABTest = {
  enabled: true,
  split: { A: 50, B: 50 },
  tracked_event: '',
  tracked_condition: { field: '', op: 'eq', value: '' },
}

const OPS = ['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains']

export function ABConfig({ abTest, onChange }: Props) {
  const enabled = abTest !== null
  const value = abTest ?? DEFAULT

  const setSplit = (aVal: number) => {
    const clamped = Math.max(0, Math.min(100, aVal))
    onChange({ ...value, split: { A: clamped, B: 100 - clamped } })
  }

  const setCond = (patch: Partial<ABTest['tracked_condition']>) =>
    onChange({ ...value, tracked_condition: { ...value.tracked_condition, ...patch } })

  return (
    <div style={{ borderTop: '1px solid #dee2e6', paddingTop: 12, marginTop: 12 }}>
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', marginBottom: 10 }}>
        <input type="checkbox" checked={enabled} onChange={(e) => onChange(e.target.checked ? DEFAULT : null)} />
        <strong style={{ fontSize: 13 }}>A/B test</strong>
      </label>
      {enabled && (
        <div>
          <div style={{ marginBottom: 10 }}>
            <span style={label}>Traffic split — Variant A: {value.split.A}% / B: {value.split.B}%</span>
            <input type="range" min={0} max={100} value={value.split.A} onChange={(e) => setSplit(Number(e.target.value))} style={{ width: '100%' }} />
          </div>
          <div style={{ marginBottom: 10 }}>
            <span style={label}>Tracked event type</span>
            <input style={inputStyle} value={value.tracked_event} onChange={(e) => onChange({ ...value, tracked_event: e.target.value })} placeholder="lead.stage_changed" />
          </div>
          <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
            <div style={{ flex: 2 }}>
              <span style={label}>Condition field</span>
              <input style={inputStyle} value={value.tracked_condition.field} onChange={(e) => setCond({ field: e.target.value })} placeholder="payload.new_stage" />
            </div>
            <div style={{ flex: 1 }}>
              <span style={label}>Operator</span>
              <select style={inputStyle} value={value.tracked_condition.op} onChange={(e) => setCond({ op: e.target.value })}>
                {OPS.map((op) => <option key={op} value={op}>{op}</option>)}
              </select>
            </div>
            <div style={{ flex: 2 }}>
              <span style={label}>Value</span>
              <input style={inputStyle} value={String(value.tracked_condition.value)} onChange={(e) => setCond({ value: e.target.value })} placeholder="exam_scheduled" />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
