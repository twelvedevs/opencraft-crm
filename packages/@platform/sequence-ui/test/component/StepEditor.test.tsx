import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { GatewayApiClient } from '../../src/api/GatewayApiClient.js'
import { GATEWAY_URL, mockSequence } from '../msw-handlers.js'
import { StepEditor } from '../../src/components/StepEditor.js'
import type { StepDraft } from '../../src/types.js'

const step1 = mockSequence.steps[0] as StepDraft
const step2: StepDraft = {
  id: 'step-x',
  delay: { value: 48, unit: 'hours' },
  action: { type: 'send_email', params: { template_id: 'em-1', to_field: 'context.email', from_field: 'context.from', context: 'context', dedup_key: 'dk' } },
}

function renderEditor(step: StepDraft, overrides: Partial<React.ComponentProps<typeof StepEditor>> = {}) {
  const gatewayClient = new GatewayApiClient(GATEWAY_URL, 'tok')
  const props = {
    step,
    gatewayClient,
    onUpdate: vi.fn(),
    onRemove: vi.fn(),
    ...overrides,
  }
  return { ...render(<StepEditor {...props} />), props }
}

describe('StepEditor', () => {
  it('renders delay value and unit', () => {
    renderEditor(step1)
    expect(screen.getByDisplayValue('24')).toBeInTheDocument()
    expect(screen.getByDisplayValue('hours')).toBeInTheDocument()
  })

  it('renders send_message action type selected', () => {
    renderEditor(step1)
    expect((screen.getByRole('combobox', { name: /action type/i }) as HTMLSelectElement).value).toBe('send_message')
  })

  it('renders send_email form when action type is send_email', () => {
    renderEditor(step2)
    expect((screen.getByRole('combobox', { name: /action type/i }) as HTMLSelectElement).value).toBe('send_email')
    expect(screen.getByDisplayValue('em-1')).toBeInTheDocument()
  })

  it('switching action type updates form area', async () => {
    renderEditor(step1)
    const select = screen.getByRole('combobox', { name: /action type/i })
    await userEvent.selectOptions(select, 'emit_event')
    expect(screen.getByPlaceholderText('nurturing.no_response_escalation')).toBeInTheDocument()
  })

  it('calls onUpdate when delay value changes', async () => {
    const { props } = renderEditor(step1)
    const delayInput = screen.getByDisplayValue('24')
    await userEvent.clear(delayInput)
    await userEvent.type(delayInput, '48')
    await waitFor(() => expect(props.onUpdate).toHaveBeenCalled())
  })

  it('calls onRemove when Remove Step button is clicked', async () => {
    const { props } = renderEditor(step1)
    await userEvent.click(screen.getByRole('button', { name: /remove step/i }))
    expect(props.onRemove).toHaveBeenCalled()
  })

  it('opens TemplatePicker when Browse button is clicked for send_message', async () => {
    renderEditor(step1)
    await userEvent.click(screen.getByRole('button', { name: 'Browse' }))
    await waitFor(() => expect(document.querySelector('.sq-modal-overlay')).toBeInTheDocument())
  })
})
