import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { server } from '../msw-server.js'
import { http, HttpResponse } from 'msw'
import { GATEWAY_URL, mockTemplates } from '../msw-handlers.js'
import { GatewayApiClient } from '../../src/api/GatewayApiClient.js'
import { TemplatePicker } from '../../src/components/TemplatePicker.js'

function renderPicker(overrides: Partial<React.ComponentProps<typeof TemplatePicker>> = {}) {
  const client = new GatewayApiClient(GATEWAY_URL, 'tok')
  const props = { client, channel: 'sms' as const, onSelect: vi.fn(), onClose: vi.fn(), ...overrides }
  return { ...render(<TemplatePicker {...props} />), props }
}

describe('TemplatePicker', () => {
  it('renders modal overlay', () => {
    renderPicker()
    expect(document.querySelector('.sq-modal-overlay')).toBeInTheDocument()
  })

  it('loads and displays templates on mount', async () => {
    renderPicker()
    await waitFor(() => expect(screen.getByText('contacted-followup-sms-1')).toBeInTheDocument())
    expect(screen.getByText('contacted-followup-sms-2')).toBeInTheDocument()
  })

  it('calls onSelect and onClose when template is clicked', async () => {
    const { props } = renderPicker()
    await waitFor(() => screen.getByText('contacted-followup-sms-1'))
    await userEvent.click(screen.getByText('contacted-followup-sms-1'))
    expect(props.onSelect).toHaveBeenCalledWith('sms-1')
    expect(props.onClose).toHaveBeenCalled()
  })

  it('calls onClose when close button is clicked', async () => {
    const { props } = renderPicker()
    await userEvent.click(screen.getByRole('button', { name: '✕' }))
    expect(props.onClose).toHaveBeenCalled()
  })

  it('sends search query to API after typing', async () => {
    let capturedUrl = ''
    server.use(
      http.get(`${GATEWAY_URL}/templates`, ({ request }) => {
        capturedUrl = request.url
        return HttpResponse.json([])
      }),
    )
    renderPicker()
    const input = screen.getByRole('searchbox')
    await userEvent.type(input, 'followup')
    await waitFor(() => expect(capturedUrl).toContain('q=followup'), { timeout: 1000 })
  })

  it('filters by channel=email when channel prop is email', async () => {
    let capturedUrl = ''
    server.use(http.get(`${GATEWAY_URL}/templates`, ({ request }) => { capturedUrl = request.url; return HttpResponse.json([]) }))
    renderPicker({ channel: 'email' })
    await waitFor(() => expect(capturedUrl).toContain('channel=email'))
  })
})
