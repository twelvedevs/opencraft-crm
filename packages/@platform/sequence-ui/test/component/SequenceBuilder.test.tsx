import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { server } from '../msw-server.js'
import { http, HttpResponse } from 'msw'
import { NURTURING_URL, GATEWAY_URL, mockSequence } from '../msw-handlers.js'
import { SequenceBuilder } from '../../src/components/SequenceBuilder.js'

function renderBuilder(overrides: Partial<React.ComponentProps<typeof SequenceBuilder>> = {}) {
  const props = {
    sequenceId: 'seq-1',
    nurturingEngineUrl: NURTURING_URL,
    crmGatewayUrl: GATEWAY_URL,
    token: 'tok',
    userRole: 'marketing_manager' as const,
    onBack: vi.fn(),
    ...overrides,
  }
  return { ...render(<SequenceBuilder {...props} />), props }
}

describe('SequenceBuilder', () => {
  it('renders sequence name after loading', async () => {
    renderBuilder()
    await waitFor(() => expect(screen.getByText('No Response Follow-up')).toBeInTheDocument())
  })

  it('shows Builder, Enrollments tabs', async () => {
    renderBuilder()
    await waitFor(() => screen.getByText('No Response Follow-up'))
    expect(screen.getByRole('tab', { name: 'Builder' })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: 'Enrollments' })).toBeInTheDocument()
  })

  it('shows A/B Results tab when ab_test is set', async () => {
    renderBuilder()
    await waitFor(() => screen.getByText('No Response Follow-up'))
    expect(screen.getByRole('tab', { name: 'A/B Results' })).toBeInTheDocument()
  })

  it('does not show A/B Results tab when ab_test is null', async () => {
    server.use(
      http.get(`${NURTURING_URL}/sequences/seq-1`, () =>
        HttpResponse.json({ ...mockSequence, ab_test: null }),
      ),
    )
    renderBuilder()
    await waitFor(() => screen.getByText('No Response Follow-up'))
    expect(screen.queryByRole('tab', { name: 'A/B Results' })).not.toBeInTheDocument()
  })

  it('switches to Enrollments tab on click', async () => {
    renderBuilder()
    await waitFor(() => screen.getByText('No Response Follow-up'))
    await userEvent.click(screen.getByRole('tab', { name: 'Enrollments' }))
    await waitFor(() => expect(screen.getByText('enr-1')).toBeInTheDocument())
  })

  it('disables Activate button for marketing_staff', async () => {
    renderBuilder({ userRole: 'marketing_staff' })
    await waitFor(() => screen.getByText('No Response Follow-up'))
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument()
  })

  it('calls onBack when Back button is clicked', async () => {
    const { props } = renderBuilder()
    await waitFor(() => screen.getByText('No Response Follow-up'))
    await userEvent.click(screen.getByRole('button', { name: /back/i }))
    expect(props.onBack).toHaveBeenCalled()
  })

  it('Save Draft button calls PUT endpoint and includes the pending edits in the body', async () => {
    let putBody: unknown = null
    server.use(
      http.put(`${NURTURING_URL}/sequences/seq-1`, async ({ request }) => {
        putBody = await request.json()
        return HttpResponse.json({})
      }),
    )
    renderBuilder()
    await waitFor(() => screen.getByText('No Response Follow-up'))
    // The mock sequence has 2 steps; clicking Add Step should produce a 3-step payload.
    await userEvent.click(screen.getByRole('button', { name: '+ Add Step' }))
    await userEvent.click(screen.getByRole('button', { name: /save draft/i }))
    await waitFor(() => expect(putBody).not.toBeNull())
    expect((putBody as { steps: unknown[] }).steps).toHaveLength(3)
  })
})
