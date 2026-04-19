import React from 'react'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { server } from '../msw-server.js'
import { http, HttpResponse } from 'msw'
import { NURTURING_URL } from '../msw-handlers.js'
import { SequenceList } from '../../src/components/SequenceList.js'

function renderList(overrides: Partial<React.ComponentProps<typeof SequenceList>> = {}) {
  const props = {
    nurturingEngineUrl: NURTURING_URL,
    token: 'tok',
    userRole: 'marketing_manager' as const,
    onEdit: vi.fn(),
    ...overrides,
  }
  return { ...render(<SequenceList {...props} />), props }
}

describe('SequenceList', () => {
  it('renders sequence names after loading', async () => {
    renderList()
    await waitFor(() => expect(screen.getByText('No Response Follow-up')).toBeInTheDocument())
    expect(screen.getByText('Welcome Drip')).toBeInTheDocument()
  })

  it('shows status badges', async () => {
    renderList()
    await waitFor(() => expect(screen.getByText('active')).toBeInTheDocument())
    expect(screen.getByText('draft')).toBeInTheDocument()
  })

  it('calls onEdit when Edit button is clicked', async () => {
    const { props } = renderList()
    await waitFor(() => screen.getByText('No Response Follow-up'))
    await userEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0])
    expect(props.onEdit).toHaveBeenCalledWith('seq-1')
  })

  it('shows Activate/Disable for marketing_manager', async () => {
    renderList({ userRole: 'marketing_manager' })
    await waitFor(() => screen.getByText('No Response Follow-up'))
    expect(screen.getByRole('button', { name: 'Disable' })).toBeInTheDocument() // seq-1 is active
    expect(screen.getByRole('button', { name: 'Activate' })).toBeInTheDocument() // seq-2 is draft
  })

  it('hides Activate/Disable for marketing_staff', async () => {
    renderList({ userRole: 'marketing_staff' })
    await waitFor(() => screen.getByText('No Response Follow-up'))
    expect(screen.queryByRole('button', { name: 'Activate' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Disable' })).not.toBeInTheDocument()
  })

  it('calls onEdit with new sequence id after New Sequence button click', async () => {
    const { props } = renderList()
    await waitFor(() => screen.getByText('No Response Follow-up'))
    await userEvent.click(screen.getByRole('button', { name: 'New Sequence' }))
    await waitFor(() => expect(props.onEdit).toHaveBeenCalledWith('seq-new'))
  })

  it('shows error state when API fails', async () => {
    server.use(http.get(`${NURTURING_URL}/sequences`, () => HttpResponse.json({}, { status: 500 })))
    renderList()
    await waitFor(() => expect(screen.getByText(/failed/i)).toBeInTheDocument())
  })
})
