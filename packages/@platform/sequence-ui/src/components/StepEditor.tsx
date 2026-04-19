import React, { useState } from 'react'
import type { StepDraft, StepAction, SendMessageParams, SendEmailParams, CallAIParams, EmitEventParams } from '../types.js'
import type { GatewayApiClient } from '../api/GatewayApiClient.js'
import { label, inputStyle, selectStyle, dangerBtn } from './utils.js'
import { SendMessageForm } from './action-forms/SendMessageForm.js'
import { SendEmailForm } from './action-forms/SendEmailForm.js'
import { CallAIForm } from './action-forms/CallAIForm.js'
import { EmitEventForm } from './action-forms/EmitEventForm.js'
import { TemplatePicker } from './TemplatePicker.js'

const DELAY_UNITS = ['minutes', 'hours', 'days'] as const
const ACTION_TYPES = ['send_message', 'send_email', 'call_ai', 'emit_event'] as const

function defaultAction(type: StepAction['type']): StepAction {
  if (type === 'send_message') return { type, params: { template_id: '', to_field: '', from_field: '', context: 'context', dedup_key: '' } }
  if (type === 'send_email') return { type, params: { template_id: '', to_field: '', from_field: '', context: 'context', dedup_key: '' } }
  if (type === 'call_ai') return { type, params: { system_prompt: '', user_prompt: '', model: 'claude-haiku-4-5-20251001', auto_send: false } }
  return { type: 'emit_event', params: { event_type: '', payload: {}, include_context: true } }
}

interface Props {
  step: StepDraft
  gatewayClient: GatewayApiClient
  onUpdate: (updated: StepDraft) => void
  onRemove: () => void
}

export function StepEditor({ step, gatewayClient, onUpdate, onRemove }: Props) {
  const [localStep, setLocalStep] = useState<StepDraft>(step)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [pickerChannel, setPickerChannel] = useState<'sms' | 'email'>('sms')

  // Sync local step from prop when the step identity changes (different step selected)
  React.useEffect(() => {
    setLocalStep(step)
  }, [step.id])

  const update = (updated: StepDraft) => {
    setLocalStep(updated)
    onUpdate(updated)
  }

  const setDelay = (patch: Partial<StepDraft['delay']>) =>
    update({ ...localStep, delay: { ...localStep.delay, ...patch } })

  const setActionType = (type: StepAction['type']) =>
    update({ ...localStep, action: defaultAction(type) })

  const setParams = (params: StepAction['params']) =>
    update({ ...localStep, action: { ...localStep.action, params } as StepAction })

  const setAbOverride = (override: Record<string, unknown> | undefined) =>
    update({ ...localStep, ab_variant_override: override ? { B: override } : undefined })

  const openPicker = (channel: 'sms' | 'email') => { setPickerChannel(channel); setPickerOpen(true) }
  const onTemplateSelect = (templateId: string) => {
    const p = localStep.action.params as unknown as Record<string, unknown>
    setParams({ ...p, template_id: templateId } as unknown as StepAction['params'])
  }

  const renderForm = () => {
    const { type, params } = localStep.action
    if (type === 'send_message') {
      return (
        <SendMessageForm
          params={params as SendMessageParams}
          abOverride={localStep.ab_variant_override?.B}
          onParamsChange={(p) => setParams(p)}
          onAbOverrideChange={setAbOverride}
          onBrowseTemplate={() => openPicker('sms')}
        />
      )
    }
    if (type === 'send_email') {
      return (
        <SendEmailForm
          params={params as SendEmailParams}
          onParamsChange={(p) => setParams(p)}
          onBrowseTemplate={() => openPicker('email')}
        />
      )
    }
    if (type === 'call_ai') {
      return <CallAIForm params={params as CallAIParams} onParamsChange={(p) => setParams(p)} />
    }
    return <EmitEventForm params={params as EmitEventParams} onParamsChange={(p) => setParams(p)} />
  }

  return (
    <div style={{ padding: 16, height: '100%', overflowY: 'auto', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <strong style={{ fontSize: 14 }}>Edit Step</strong>
        <button style={dangerBtn} onClick={onRemove}>Remove Step</button>
      </div>

      <div style={{ marginBottom: 16, padding: 12, background: '#f8f9fa', borderRadius: 6 }}>
        <div style={{ display: 'flex', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <span style={label}>Delay</span>
            <input
              style={inputStyle}
              type="number"
              min={0}
              value={localStep.delay.value}
              onChange={(e) => setDelay({ value: Number(e.target.value) })}
            />
          </div>
          <div style={{ flex: 1 }}>
            <span style={label}>Unit</span>
            <select
              style={selectStyle}
              value={localStep.delay.unit}
              onChange={(e) => setDelay({ unit: e.target.value as StepDraft['delay']['unit'] })}
            >
              {DELAY_UNITS.map((u) => <option key={u} value={u}>{u}</option>)}
            </select>
          </div>
        </div>
      </div>

      <div style={{ marginBottom: 16 }}>
        <label htmlFor="action-type-select" style={label}>Action type</label>
        <select
          id="action-type-select"
          style={selectStyle}
          value={localStep.action.type}
          onChange={(e) => setActionType(e.target.value as StepAction['type'])}
        >
          {ACTION_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </div>

      {renderForm()}

      {pickerOpen && (
        <TemplatePicker
          client={gatewayClient}
          channel={pickerChannel}
          onSelect={onTemplateSelect}
          onClose={() => setPickerOpen(false)}
        />
      )}
    </div>
  )
}
